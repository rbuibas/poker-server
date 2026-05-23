import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type AdminClient = SupabaseClient;

export function createAdminClient(url: string, serviceRoleKey: string): AdminClient {
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
