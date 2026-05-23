import type { AdminClient } from './supabaseAdmin.js';

export interface LoungeSettings {
  turn_timer_seconds: number;
  max_players: number;
  small_blind: number;
  big_blind: number;
  default_buy_in: number;
}

export interface LoungeRow {
  id: string;
  code: string;
  name: string;
  owner_id: string;
  persistent: boolean;
  created_at: string;
  last_active_at: string;
  settings: LoungeSettings;
}

export interface ILoungeStore {
  getLounge(loungeId: string): Promise<LoungeRow | null>;
  isMember(loungeId: string, userId: string): Promise<boolean>;
  getLoungeForMember(
    loungeId: string,
    userId: string,
  ): Promise<
    | { lounge: LoungeRow; isOwner: boolean }
    | { error: 'not_found' | 'not_member' }
  >;
}

export class LoungeStore implements ILoungeStore {
  constructor(private readonly db: AdminClient) {}

  async getLounge(loungeId: string): Promise<LoungeRow | null> {
    const { data, error } = await this.db
      .from('lounges')
      .select('*')
      .eq('id', loungeId)
      .maybeSingle();
    if (error) throw error;
    return (data as LoungeRow | null) ?? null;
  }

  async isMember(loungeId: string, userId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('lounge_members')
      .select('user_id')
      .eq('lounge_id', loungeId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    return !!data;
  }

  async getLoungeForMember(
    loungeId: string,
    userId: string,
  ): Promise<{ lounge: LoungeRow; isOwner: boolean } | { error: 'not_found' | 'not_member' }> {
    const lounge = await this.getLounge(loungeId);
    if (!lounge) return { error: 'not_found' };
    const member = await this.isMember(loungeId, userId);
    if (!member) return { error: 'not_member' };
    return { lounge, isOwner: lounge.owner_id === userId };
  }
}
