import type { AdminClient } from './supabaseAdmin.js';

export interface SessionRow {
  id: string;
  lounge_id: string;
  started_at: string;
  ended_at: string | null;
  hands_played: number;
  status: 'active' | 'ended';
}

export interface ISessionStore {
  getActiveByLounge(loungeId: string): Promise<SessionRow | null>;
  createSession(loungeId: string): Promise<SessionRow>;
  upsertSessionPlayer(params: { sessionId: string; userId: string; buyIn: number }): Promise<void>;
  recordPlayerLeft(params: { sessionId: string; userId: string; cashOut: number }): Promise<void>;
  incrementHandsPlayed(sessionId: string): Promise<void>;
}

export class SessionStore implements ISessionStore {
  constructor(private readonly db: AdminClient) {}

  async getActiveByLounge(loungeId: string): Promise<SessionRow | null> {
    const { data, error } = await this.db
      .from('sessions')
      .select('*')
      .eq('lounge_id', loungeId)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw error;
    return (data as SessionRow | null) ?? null;
  }

  async createSession(loungeId: string): Promise<SessionRow> {
    const { data, error } = await this.db
      .from('sessions')
      .insert({ lounge_id: loungeId })
      .select('*')
      .single();
    if (error) throw error;
    return data as SessionRow;
  }

  async upsertSessionPlayer(params: {
    sessionId: string;
    userId: string;
    buyIn: number;
  }): Promise<void> {
    const { sessionId, userId, buyIn } = params;
    const { data: existing, error: selErr } = await this.db
      .from('session_players')
      .select('buy_in_total')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (selErr) throw selErr;
    if (existing) {
      const { error } = await this.db
        .from('session_players')
        .update({
          buy_in_total: (existing as { buy_in_total: number }).buy_in_total + buyIn,
          left_at: null,
        })
        .eq('session_id', sessionId)
        .eq('user_id', userId);
      if (error) throw error;
    } else {
      const { error } = await this.db.from('session_players').insert({
        session_id: sessionId,
        user_id: userId,
        buy_in_total: buyIn,
      });
      if (error) throw error;
    }
  }

  async recordPlayerLeft(params: {
    sessionId: string;
    userId: string;
    cashOut: number;
  }): Promise<void> {
    const { sessionId, userId, cashOut } = params;
    const { data: existing, error: selErr } = await this.db
      .from('session_players')
      .select('cash_out_total')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (selErr) throw selErr;
    const prevCashOut = (existing as { cash_out_total: number } | null)?.cash_out_total ?? 0;
    const { error } = await this.db
      .from('session_players')
      .update({
        cash_out_total: prevCashOut + cashOut,
        left_at: new Date().toISOString(),
      })
      .eq('session_id', sessionId)
      .eq('user_id', userId);
    if (error) throw error;
  }

  async incrementHandsPlayed(sessionId: string): Promise<void> {
    const { data, error: selErr } = await this.db
      .from('sessions')
      .select('hands_played')
      .eq('id', sessionId)
      .single();
    if (selErr) throw selErr;
    const next = (data as { hands_played: number }).hands_played + 1;
    const { error } = await this.db
      .from('sessions')
      .update({ hands_played: next })
      .eq('id', sessionId);
    if (error) throw error;
  }
}
