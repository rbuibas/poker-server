// In-memory implementations of the persistence interfaces.
// Used by integration tests AND by the server's DEV_NO_DB local-play mode.
import { randomUUID } from 'node:crypto';
import type { ILoungeStore, LoungeRow, LoungeSettings } from './lounges.js';
import type { ISessionStore, SessionRow } from './sessions.js';
import type { IHandWriter, PersistHandInput } from './handWriter.js';

export class InMemoryLoungeStore implements ILoungeStore {
  readonly lounges = new Map<string, LoungeRow>();
  readonly members = new Map<string, Set<string>>(); // loungeId → userIds

  addLounge(input: {
    id?: string;
    name?: string;
    ownerId: string;
    settings?: Partial<LoungeSettings>;
  }): LoungeRow {
    const id = input.id ?? randomUUID();
    const settings: LoungeSettings = {
      turn_timer_seconds: 30,
      max_players: 9,
      small_blind: 5,
      big_blind: 10,
      default_buy_in: 1000,
      ...input.settings,
    };
    const lounge: LoungeRow = {
      id,
      code: id.slice(0, 6).toUpperCase(),
      name: input.name ?? 'Dev Lounge',
      owner_id: input.ownerId,
      persistent: false,
      created_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      settings,
    };
    this.lounges.set(id, lounge);
    this.addMember(id, input.ownerId);
    return lounge;
  }

  addMember(loungeId: string, userId: string): void {
    let set = this.members.get(loungeId);
    if (!set) {
      set = new Set();
      this.members.set(loungeId, set);
    }
    set.add(userId);
  }

  async getLounge(loungeId: string): Promise<LoungeRow | null> {
    return this.lounges.get(loungeId) ?? null;
  }

  async isMember(loungeId: string, userId: string): Promise<boolean> {
    return !!this.members.get(loungeId)?.has(userId);
  }

  async getLoungeForMember(
    loungeId: string,
    userId: string,
  ): Promise<{ lounge: LoungeRow; isOwner: boolean } | { error: 'not_found' | 'not_member' }> {
    const lounge = this.lounges.get(loungeId);
    if (!lounge) return { error: 'not_found' };
    if (!this.members.get(loungeId)?.has(userId)) return { error: 'not_member' };
    return { lounge, isOwner: lounge.owner_id === userId };
  }
}

interface SessionPlayerRow {
  session_id: string;
  user_id: string;
  buy_in_total: number;
  cash_out_total: number;
  hands_played: number;
  hands_won: number;
  joined_at: string;
  left_at: string | null;
}

export class InMemorySessionStore implements ISessionStore {
  readonly sessions = new Map<string, SessionRow>();
  readonly players = new Map<string, SessionPlayerRow>(); // key: sessionId|userId

  private key(sessionId: string, userId: string): string {
    return `${sessionId}|${userId}`;
  }

  async getActiveByLounge(loungeId: string): Promise<SessionRow | null> {
    for (const s of this.sessions.values()) {
      if (s.lounge_id === loungeId && s.status === 'active') return s;
    }
    return null;
  }

  async createSession(loungeId: string): Promise<SessionRow> {
    const row: SessionRow = {
      id: randomUUID(),
      lounge_id: loungeId,
      started_at: new Date().toISOString(),
      ended_at: null,
      hands_played: 0,
      status: 'active',
    };
    this.sessions.set(row.id, row);
    return row;
  }

  async upsertSessionPlayer(params: {
    sessionId: string;
    userId: string;
    buyIn: number;
  }): Promise<void> {
    const k = this.key(params.sessionId, params.userId);
    const existing = this.players.get(k);
    if (existing) {
      existing.buy_in_total += params.buyIn;
      existing.left_at = null;
    } else {
      this.players.set(k, {
        session_id: params.sessionId,
        user_id: params.userId,
        buy_in_total: params.buyIn,
        cash_out_total: 0,
        hands_played: 0,
        hands_won: 0,
        joined_at: new Date().toISOString(),
        left_at: null,
      });
    }
  }

  async recordPlayerLeft(params: {
    sessionId: string;
    userId: string;
    cashOut: number;
  }): Promise<void> {
    const row = this.players.get(this.key(params.sessionId, params.userId));
    if (!row) return;
    row.cash_out_total += params.cashOut;
    row.left_at = new Date().toISOString();
  }

  async incrementHandsPlayed(sessionId: string): Promise<void> {
    const row = this.sessions.get(sessionId);
    if (row) row.hands_played += 1;
  }

  bumpPlayerCounters(sessionId: string, userId: string, won: boolean): void {
    const row = this.players.get(this.key(sessionId, userId));
    if (!row) return;
    row.hands_played += 1;
    if (won) row.hands_won += 1;
  }
}

interface HandRow {
  id: string;
  session_id: string;
  hand_number: number;
  button_seat: number;
  board: unknown;
  pot_total: number;
  event_log: unknown;
}

interface HandPlayerRow {
  hand_id: string;
  user_id: string;
  seat: number;
  hole_cards: unknown;
  showed_cards: boolean;
  result: string;
  amount_won: number;
  amount_contributed: number;
}

export class InMemoryHandWriter implements IHandWriter {
  readonly hands: HandRow[] = [];
  readonly handPlayers: HandPlayerRow[] = [];

  constructor(private readonly sessionStore: InMemorySessionStore) {}

  async persistHand(input: PersistHandInput): Promise<string | null> {
    const id = randomUUID();
    this.hands.push({
      id,
      session_id: input.sessionId,
      hand_number: input.handNumber,
      button_seat: input.buttonSeat,
      board: input.board,
      pot_total: input.potTotal,
      event_log: input.eventLog,
    });
    for (const p of input.players) {
      this.handPlayers.push({
        hand_id: id,
        user_id: p.userId,
        seat: p.seat,
        hole_cards: p.holeCards,
        showed_cards: p.showedCards,
        result: p.result,
        amount_won: p.amountWon,
        amount_contributed: p.amountContributed,
      });
    }
    await this.sessionStore.incrementHandsPlayed(input.sessionId);
    for (const p of input.players) {
      const won = p.result === 'won' || p.result === 'split';
      this.sessionStore.bumpPlayerCounters(input.sessionId, p.userId, won);
    }
    return id;
  }
}
