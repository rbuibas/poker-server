import type { Card, GameEvent } from 'poker-engine';
import type { Logger } from '../logging.js';
import type { AdminClient } from './supabaseAdmin.js';
import type { ISessionStore } from './sessions.js';

export interface PersistHandInput {
  sessionId: string;
  handNumber: number;
  buttonSeat: number;
  board: Card[];
  potTotal: number;
  /** Full unredacted hand event log (server-only). */
  eventLog: GameEvent[];
  /**
   * Per-player data, keyed by userId. Includes hole cards (always known
   * server-side) and computed result.
   */
  players: {
    userId: string;
    seat: number;
    holeCards: [Card, Card];
    showedCards: boolean;
    result: 'won' | 'lost' | 'folded' | 'split';
    amountWon: number;
    amountContributed: number;
  }[];
}

export interface IHandWriter {
  persistHand(input: PersistHandInput): Promise<string | null>;
}

export class HandWriter implements IHandWriter {
  constructor(
    private readonly db: AdminClient,
    private readonly sessions: ISessionStore,
    private readonly logger: Logger,
  ) {}

  /**
   * Best-effort: writes hand + per-player rows and bumps counters. Never
   * throws — caller continues the game on failure.
   * TODO(Phase 4): retry queue for failed writes.
   */
  async persistHand(input: PersistHandInput): Promise<string | null> {
    const log = this.logger.child({
      sessionId: input.sessionId,
      handNumber: input.handNumber,
    });
    try {
      const { data, error } = await this.db
        .from('hands')
        .insert({
          session_id: input.sessionId,
          hand_number: input.handNumber,
          button_seat: input.buttonSeat,
          board: input.board,
          pot_total: input.potTotal,
          event_log: input.eventLog,
        })
        .select('id')
        .single();
      if (error) throw error;
      const handId = (data as { id: string }).id;

      const handPlayersRows = input.players.map((p) => ({
        hand_id: handId,
        user_id: p.userId,
        seat: p.seat,
        hole_cards: p.holeCards,
        showed_cards: p.showedCards,
        result: p.result,
        amount_won: p.amountWon,
        amount_contributed: p.amountContributed,
      }));

      const { error: hpErr } = await this.db.from('hand_players').insert(handPlayersRows);
      if (hpErr) throw hpErr;

      // Increment session and per-player counters.
      await this.sessions.incrementHandsPlayed(input.sessionId);
      for (const p of input.players) {
        await this.bumpPlayerCounters({
          sessionId: input.sessionId,
          userId: p.userId,
          won: p.result === 'won' || p.result === 'split',
        });
      }

      log.info({ handId }, 'hand persisted');
      return handId;
    } catch (err) {
      log.error({ err }, 'hand persistence failed');
      return null;
    }
  }

  private async bumpPlayerCounters(params: {
    sessionId: string;
    userId: string;
    won: boolean;
  }): Promise<void> {
    const { sessionId, userId, won } = params;
    const { data, error: selErr } = await this.db
      .from('session_players')
      .select('hands_played, hands_won')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (selErr) throw selErr;
    if (!data) return;
    const row = data as { hands_played: number; hands_won: number };
    const { error } = await this.db
      .from('session_players')
      .update({
        hands_played: row.hands_played + 1,
        hands_won: row.hands_won + (won ? 1 : 0),
      })
      .eq('session_id', sessionId)
      .eq('user_id', userId);
    if (error) throw error;
  }
}
