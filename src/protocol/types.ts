import type {
  Card,
  GameEvent,
  LegalActions,
  PlayerAction,
  PlayerView,
} from 'poker-engine';

// ============================================================================
// Server-known shapes
// ============================================================================

export interface SessionSummary {
  id: string;
  loungeId: string;
  startedAt: string;
  handsPlayed: number;
  status: 'active' | 'ended';
}

export type ErrorCode =
  | 'auth_failed'
  | 'not_member'
  | 'not_owner'
  | 'invalid_action'
  | 'hand_in_progress'
  | 'not_your_turn'
  | 'invalid_amount'
  | 'seat_taken'
  | 'no_active_session'
  | 'no_hand_in_progress'
  | 'internal_error'
  | 'server_shutting_down'
  | 'rate_limited';

export interface ServerErrorPayload {
  code: ErrorCode;
  message: string;
}

// ============================================================================
// Server → client events
// ============================================================================

export interface SessionStatePayload {
  session: SessionSummary;
  table: PlayerView;
  history: GameEvent[];
}

export interface PlayerJoinedPayload {
  userId: string;
  seat: number;
  stack: number;
}

export interface PlayerLeftPayload {
  userId: string;
  reason: 'stood_up' | 'kicked';
}

export interface PlayerStatusPayload {
  userId: string;
  status: 'sitting' | 'sitout' | 'away';
}

export interface YourTurnPayload {
  legalActions: LegalActions;
  deadlineMs: number;
}

export interface HandSummaryWinner {
  playerId: string;
  amount: number;
}

export interface HandSummaryShowdownReveal {
  playerId: string;
  cards: [Card, Card];
  handDescription: string;
}

export interface HandSummary {
  handNumber: number;
  board: Card[];
  potTotal: number;
  pots: { potIndex: number; winners: HandSummaryWinner[] }[];
  showdown: HandSummaryShowdownReveal[] | null;
  finalStacks: Record<string, number>;
}

export interface HandCompletePayload {
  handId: string | null;
  summary: HandSummary;
}

// ============================================================================
// Client → server payload types (mirror zod schemas in schemas.ts)
// ============================================================================

export interface SessionStartPayload {
  loungeId: string;
}

export interface SessionJoinRoomPayload {
  loungeId: string;
}

export interface SessionSitDownPayload {
  loungeId: string;
  seat: number;
  buyIn: number;
}

export interface SessionStandUpPayload {
  loungeId: string;
}

export interface SessionRebuyPayload {
  loungeId: string;
  amount: number;
}

export interface SessionSitOutPayload {
  loungeId: string;
  sitOut: boolean;
}

export interface SessionKickPayload {
  loungeId: string;
  targetUserId: string;
}

export interface SessionLeaveRoomPayload {
  loungeId: string;
}

export interface HandStartPayload {
  loungeId: string;
}

export interface HandActionPayload {
  loungeId: string;
  action: PlayerAction;
}

// Socket.IO data field — set by socketAuth middleware after JWT verify
export interface SocketData {
  userId: string;
}
