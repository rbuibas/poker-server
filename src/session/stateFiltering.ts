import type { Card, GameEvent, PokerTable } from 'poker-engine';
import type { Server } from 'socket.io';
import { sessionRoom, userRoom } from '../connection/rooms.js';
import type {
  HandSummary,
  HandSummaryShowdownReveal,
  HandSummaryWinner,
  SessionStatePayload,
  SessionSummary,
} from '../protocol/types.js';

/**
 * Centralized broadcaster. The ONLY code path that emits engine events to
 * clients goes through this module — this is the hole-card-leak choke point.
 *
 * Rules:
 *   - `hole_cards_dealt` events go to `user:<recipientId>` only.
 *   - All other events go to `session:<sessionId>` publicly.
 *   - Showdown events naturally reveal cards of players who reached showdown
 *     (this is the intended public reveal).
 */
export function broadcastEvents(
  io: Server,
  sessionId: string,
  events: GameEvent[],
): void {
  for (const event of events) {
    if (event.type === 'hole_cards_dealt') {
      io.to(userRoom(event.playerId)).emit('hand:event', event);
    } else {
      io.to(sessionRoom(sessionId)).emit('hand:event', event);
    }
  }
}

/**
 * Build per-recipient session snapshot. Uses engine helpers that already
 * redact opponents' hole cards.
 */
export function buildSessionState(
  table: PokerTable,
  session: SessionSummary,
  userId: string,
): SessionStatePayload {
  return {
    session,
    table: table.getPlayerView(userId),
    history: table.getHandHistoryForPlayer(userId),
  };
}

/**
 * Build the summary attached to `hand:complete` by walking the unredacted
 * hand event log. Safe to broadcast — only includes cards already revealed
 * by showdown events.
 */
export function buildHandSummary(
  log: GameEvent[],
  handNumber: number,
  pots: { potIndex: number; winners: HandSummaryWinner[] }[],
): HandSummary {
  let board: Card[] = [];
  let finalStacks: Record<string, number> = {};
  let showdown: HandSummaryShowdownReveal[] | null = null;

  for (const e of log) {
    if (e.type === 'board_dealt') {
      board = [...board, ...e.cards];
    } else if (e.type === 'hand_complete') {
      finalStacks = e.finalStacks;
    } else if (e.type === 'showdown') {
      showdown = e.reveals.map((r) => ({
        playerId: r.playerId,
        cards: r.cards,
        handDescription: r.handDescription,
      }));
    }
  }

  const potTotal = pots.reduce(
    (sum, p) => sum + p.winners.reduce((s, w) => s + w.amount, 0),
    0,
  );

  return { handNumber, board, potTotal, pots, showdown, finalStacks };
}
