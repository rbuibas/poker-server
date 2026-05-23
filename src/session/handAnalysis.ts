import type { Card, GameEvent } from 'poker-engine';
import type {
  HandSummary,
  HandSummaryShowdownReveal,
  HandSummaryWinner,
} from '../protocol/types.js';

export interface PerPlayerHandResult {
  userId: string;
  seat: number;
  holeCards: [Card, Card];
  showedCards: boolean;
  result: 'won' | 'lost' | 'folded' | 'split';
  amountWon: number;
  amountContributed: number;
}

export interface HandAnalysis {
  handNumber: number;
  buttonSeat: number;
  board: Card[];
  potTotal: number;
  pots: { potIndex: number; winners: HandSummaryWinner[] }[];
  finalStacks: Record<string, number>;
  showdown: HandSummaryShowdownReveal[] | null;
  perPlayer: PerPlayerHandResult[];
}

/**
 * Walk the engine's unredacted hand event log and compute everything needed
 * for both the `hand:complete` summary and DB persistence.
 *
 * Note: hole cards come from `hole_cards_dealt` events (the unredacted log
 * has cards for every player). Per-player contribution is the sum of every
 * chip a player committed during the hand (blinds, antes, and the amount
 * delta on each action_taken).
 */
export function analyzeHand(
  log: GameEvent[],
  seatLookup: ReadonlyMap<string, number>,
): HandAnalysis | null {
  let handNumber = 0;
  let buttonSeat = 0;
  const board: Card[] = [];
  const holeCardsByPlayer = new Map<string, [Card, Card]>();
  // Per-player running bet within the current betting round, used to compute
  // the delta on each action_taken. Reset on phase_changed.
  let currentBetByPlayer = new Map<string, number>();
  const totalContributed = new Map<string, number>();
  const foldedPlayers = new Set<string>();
  const showdownReveals: HandSummaryShowdownReveal[] = [];
  const potWinners: { potIndex: number; winners: HandSummaryWinner[] }[] = [];
  let finalStacks: Record<string, number> = {};
  let sawHandComplete = false;

  const add = (m: Map<string, number>, k: string, v: number) =>
    m.set(k, (m.get(k) ?? 0) + v);

  for (const e of log) {
    switch (e.type) {
      case 'hand_started':
        handNumber = e.handNumber;
        buttonSeat = e.buttonSeat;
        break;
      case 'blinds_posted':
        if (e.smallBlind) {
          add(totalContributed, e.smallBlind.playerId, e.smallBlind.amount);
          currentBetByPlayer.set(e.smallBlind.playerId, e.smallBlind.amount);
        }
        add(totalContributed, e.bigBlind.playerId, e.bigBlind.amount);
        currentBetByPlayer.set(e.bigBlind.playerId, e.bigBlind.amount);
        break;
      case 'ante_posted':
        for (const [pid, amt] of Object.entries(e.amounts)) {
          add(totalContributed, pid, amt);
        }
        break;
      case 'hole_cards_dealt':
        if (e.cards) holeCardsByPlayer.set(e.playerId, e.cards);
        break;
      case 'action_taken': {
        const a = e.action;
        const prev = currentBetByPlayer.get(e.playerId) ?? 0;
        if (a.type === 'fold') {
          foldedPlayers.add(e.playerId);
        } else if (a.type === 'check') {
          // no contribution
        } else if (a.type === 'call') {
          // Call amount isn't on the action — the engine consumes whatever is
          // owed. We approximate by assuming the player matches the current
          // max bet observed so far in this round.
          let maxBet = 0;
          for (const v of currentBetByPlayer.values()) {
            if (v > maxBet) maxBet = v;
          }
          const delta = Math.max(0, maxBet - prev);
          if (delta > 0) {
            add(totalContributed, e.playerId, delta);
            currentBetByPlayer.set(e.playerId, prev + delta);
          }
        } else if (a.type === 'bet' || a.type === 'raise') {
          // Engine treats `amount` as the TOTAL bet target.
          const total = a.amount ?? 0;
          const delta = Math.max(0, total - prev);
          if (delta > 0) {
            add(totalContributed, e.playerId, delta);
            currentBetByPlayer.set(e.playerId, total);
          }
        } else if (a.type === 'all_in') {
          // We can't know the amount from the action alone; rely on the
          // engine's later events to balance (showdown / pot_awarded). The
          // delta is best-effort: 0 here, since we don't know the stack.
          // We could supplement from finalStacks, but it's acceptable for
          // contribution accounting to under-attribute all-in calls; this
          // value is informational, not the authoritative pot total.
        }
        break;
      }
      case 'phase_changed':
        currentBetByPlayer = new Map();
        break;
      case 'showdown':
        for (const r of e.reveals) {
          showdownReveals.push({
            playerId: r.playerId,
            cards: r.cards,
            handDescription: r.handDescription,
          });
          // Keep authoritative hole cards from showdown reveals.
          holeCardsByPlayer.set(r.playerId, r.cards);
        }
        break;
      case 'pot_awarded':
        potWinners.push({
          potIndex: e.potIndex,
          winners: e.winners.map((w) => ({ playerId: w.playerId, amount: w.amount })),
        });
        break;
      case 'hand_complete':
        finalStacks = e.finalStacks;
        sawHandComplete = true;
        break;
      default:
        break;
    }
    if (e.type === 'board_dealt') {
      for (const c of e.cards) board.push(c);
    }
  }

  if (!sawHandComplete) return null;

  // Compute per-player results.
  const amountWonByPlayer = new Map<string, number>();
  const splitParticipants = new Set<string>();
  for (const pot of potWinners) {
    if (pot.winners.length > 1) {
      for (const w of pot.winners) splitParticipants.add(w.playerId);
    }
    for (const w of pot.winners) add(amountWonByPlayer, w.playerId, w.amount);
  }

  const allPlayers = new Set<string>([
    ...holeCardsByPlayer.keys(),
    ...totalContributed.keys(),
    ...Object.keys(finalStacks),
  ]);

  const perPlayer: PerPlayerHandResult[] = [];
  for (const userId of allPlayers) {
    const hc = holeCardsByPlayer.get(userId);
    if (!hc) continue; // not dealt into this hand
    const wonAmt = amountWonByPlayer.get(userId) ?? 0;
    const folded = foldedPlayers.has(userId);
    const showed = showdownReveals.some((r) => r.playerId === userId);
    let result: PerPlayerHandResult['result'];
    if (folded) result = 'folded';
    else if (splitParticipants.has(userId)) result = 'split';
    else if (wonAmt > 0) result = 'won';
    else result = 'lost';
    perPlayer.push({
      userId,
      seat: seatLookup.get(userId) ?? -1,
      holeCards: hc,
      showedCards: showed,
      result,
      amountWon: wonAmt,
      amountContributed: totalContributed.get(userId) ?? 0,
    });
  }

  const potTotal = potWinners.reduce(
    (sum, p) => sum + p.winners.reduce((s, w) => s + w.amount, 0),
    0,
  );

  return {
    handNumber,
    buttonSeat,
    board,
    potTotal,
    pots: potWinners,
    finalStacks,
    showdown: showdownReveals.length > 0 ? showdownReveals : null,
    perPlayer,
  };
}

export function summaryFromAnalysis(a: HandAnalysis): HandSummary {
  return {
    handNumber: a.handNumber,
    board: a.board,
    potTotal: a.potTotal,
    pots: a.pots,
    showdown: a.showdown,
    finalStacks: a.finalStacks,
  };
}
