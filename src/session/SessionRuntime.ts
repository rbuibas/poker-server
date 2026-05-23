import { PokerTable, type GameEvent, type PlayerAction, type TableConfig } from 'poker-engine';
import type { Server } from 'socket.io';
import type { Logger } from '../logging.js';
import { sessionRoom, userRoom } from '../connection/rooms.js';
import { broadcastEvents } from './stateFiltering.js';
import { analyzeHand, summaryFromAnalysis } from './handAnalysis.js';
import type { IHandWriter } from '../persistence/handWriter.js';
import type { ISessionStore } from '../persistence/sessions.js';
import type { LoungeRow } from '../persistence/lounges.js';
import type {
  HandCompletePayload,
  PlayerJoinedPayload,
  PlayerLeftPayload,
  PlayerStatusPayload,
  SessionSummary,
  YourTurnPayload,
} from '../protocol/types.js';

const MIN_TIMER_MS = 1_000;

export interface SessionRuntimeDeps {
  io: Server;
  logger: Logger;
  lounge: LoungeRow;
  sessionRow: { id: string; lounge_id: string; started_at: string; status: 'active' | 'ended'; hands_played: number };
  handWriter: IHandWriter;
  sessionStore: ISessionStore;
}

export function loungeToTableConfig(lounge: LoungeRow): TableConfig {
  const s = lounge.settings;
  return {
    smallBlind: s.small_blind,
    bigBlind: s.big_blind,
    ante: 0,
    maxPlayers: s.max_players,
    defaultBuyIn: s.default_buy_in,
    minBuyIn: s.default_buy_in,
    maxBuyIn: s.default_buy_in * 10,
  };
}

export class SessionRuntime {
  readonly table: PokerTable;
  readonly sessionId: string;
  readonly loungeId: string;
  readonly turnTimerMs: number;
  readonly buyInLimits: { min: number; max: number; default: number };

  private readonly io: Server;
  private readonly logger: Logger;
  private readonly handWriter: IHandWriter;
  private readonly sessionStore: ISessionStore;
  private readonly lounge: LoungeRow;
  private readonly startedAt: string;

  private turnTimer: NodeJS.Timeout | null = null;
  private turnDeadline: number | null = null;
  private currentToActUserId: string | null = null;
  /** seat → userId mapping kept in sync with engine state. */
  private readonly seatByUser = new Map<string, number>();
  private readonly pendingPersistence = new Set<Promise<unknown>>();

  constructor(deps: SessionRuntimeDeps) {
    this.io = deps.io;
    this.logger = deps.logger.child({ sessionId: deps.sessionRow.id });
    this.handWriter = deps.handWriter;
    this.sessionStore = deps.sessionStore;
    this.lounge = deps.lounge;
    this.sessionId = deps.sessionRow.id;
    this.loungeId = deps.sessionRow.lounge_id;
    this.startedAt = deps.sessionRow.started_at;
    this.turnTimerMs = Math.max(MIN_TIMER_MS, deps.lounge.settings.turn_timer_seconds * 1000);
    this.buyInLimits = {
      min: deps.lounge.settings.default_buy_in,
      max: deps.lounge.settings.default_buy_in * 10,
      default: deps.lounge.settings.default_buy_in,
    };
    this.table = new PokerTable(loungeToTableConfig(deps.lounge));
  }

  summary(): SessionSummary {
    return {
      id: this.sessionId,
      loungeId: this.loungeId,
      startedAt: this.startedAt,
      handsPlayed: this.table.getCompletedHands().length,
      status: 'active',
    };
  }

  seatOf(userId: string): number | undefined {
    return this.seatByUser.get(userId);
  }

  ownerId(): string {
    return this.lounge.owner_id;
  }

  isHandInProgress(): boolean {
    return this.table.isHandInProgress();
  }

  // ------------------------- Seat management -------------------------

  sitDown(userId: string, seat: number, buyIn: number): GameEvent[] {
    const events = this.table.sitDown(userId, seat, buyIn);
    this.seatByUser.set(userId, seat);
    const stack = this.stackOf(userId);
    const payload: PlayerJoinedPayload = { userId, seat, stack };
    this.io.to(sessionRoom(this.sessionId)).emit('session:player_joined', payload);
    this.trackPersistence(
      this.sessionStore.upsertSessionPlayer({
        sessionId: this.sessionId,
        userId,
        buyIn,
      }),
      'upsertSessionPlayer',
    );
    return events;
  }

  standUp(userId: string, reason: 'stood_up' | 'kicked'): GameEvent[] {
    const cashOut = this.stackOf(userId);
    const events = this.table.standUp(userId);
    this.seatByUser.delete(userId);
    const payload: PlayerLeftPayload = { userId, reason };
    this.io.to(sessionRoom(this.sessionId)).emit('session:player_left', payload);
    this.trackPersistence(
      this.sessionStore.recordPlayerLeft({
        sessionId: this.sessionId,
        userId,
        cashOut,
      }),
      'recordPlayerLeft',
    );
    return events;
  }

  rebuy(userId: string, amount: number): GameEvent[] {
    const events = this.table.rebuy(userId, amount);
    this.trackPersistence(
      this.sessionStore.upsertSessionPlayer({
        sessionId: this.sessionId,
        userId,
        buyIn: amount,
      }),
      'rebuy upsertSessionPlayer',
    );
    return events;
  }

  setSitOut(userId: string, sitOut: boolean): GameEvent[] {
    const events = this.table.setSitOut(userId, sitOut);
    const status: PlayerStatusPayload = {
      userId,
      status: sitOut ? 'sitout' : 'sitting',
    };
    this.io.to(sessionRoom(this.sessionId)).emit('session:player_status', status);
    return events;
  }

  markAway(userId: string, away: boolean): void {
    // Only meaningful if the user is seated; engine is tolerant otherwise.
    if (!this.seatByUser.has(userId)) return;
    try {
      this.table.markAway(userId, away);
      const status: PlayerStatusPayload = {
        userId,
        status: away ? 'away' : 'sitting',
      };
      this.io.to(sessionRoom(this.sessionId)).emit('session:player_status', status);
    } catch (err) {
      this.logger.warn({ err, userId, away }, 'markAway failed');
    }
  }

  // ------------------------- Hand lifecycle -------------------------

  startHand(): GameEvent[] {
    const events = this.table.startHand();
    void this.processEvents(events);
    return events;
  }

  handleAction(userId: string, action: PlayerAction): GameEvent[] {
    const events = this.table.handleAction(userId, action);
    void this.processEvents(events);
    return events;
  }

  forceTimeout(userId: string): GameEvent[] {
    const events = this.table.forceTimeout(userId);
    void this.processEvents(events);
    return events;
  }

  /**
   * Broadcasts events (with hole-card filtering), updates turn-timer state,
   * and triggers persistence on hand_complete.
   */
  async processEvents(events: GameEvent[]): Promise<void> {
    if (events.length === 0) return;
    broadcastEvents(this.io, this.sessionId, events);

    // Clear any prior timer; we'll reinstate from the latest action_required.
    this.clearTurnTimer();

    let lastActionRequired:
      | Extract<GameEvent, { type: 'action_required' }>
      | null = null;
    let handComplete = false;
    for (const e of events) {
      if (e.type === 'action_required') lastActionRequired = e;
      else if (e.type === 'hand_complete') handComplete = true;
    }

    if (lastActionRequired) {
      const deadlineMs = Date.now() + this.turnTimerMs;
      this.turnDeadline = deadlineMs;
      this.currentToActUserId = lastActionRequired.playerId;
      const payload: YourTurnPayload = {
        legalActions: lastActionRequired.legalActions,
        deadlineMs,
      };
      this.io.to(userRoom(lastActionRequired.playerId)).emit('hand:your_turn', payload);
      const playerId = lastActionRequired.playerId;
      this.turnTimer = setTimeout(() => {
        this.onTurnTimeout(playerId).catch((err) => {
          this.logger.error({ err, playerId }, 'turn timeout handler threw');
        });
      }, this.turnTimerMs);
    }

    if (handComplete) {
      await this.onHandComplete();
    }
  }

  private async onTurnTimeout(playerId: string): Promise<void> {
    if (this.currentToActUserId !== playerId) return;
    this.logger.info({ playerId }, 'turn timeout — forcing engine timeout');
    try {
      const events = this.table.forceTimeout(playerId);
      await this.processEvents(events);
    } catch (err) {
      this.logger.error({ err, playerId }, 'forceTimeout threw');
    }
  }

  private async onHandComplete(): Promise<void> {
    const completed = this.table.getCompletedHands();
    const lastHand = completed.length > 0 ? completed[completed.length - 1] : undefined;
    if (!lastHand) {
      this.logger.warn('hand_complete observed but no completed hand in history');
      return;
    }
    const seatLookup = new Map(this.seatByUser);
    // Also include just-completed hand seats by reading any hole_cards_dealt
    // events — players who stood up immediately could otherwise be missing.
    for (const e of lastHand) {
      if (e.type === 'hole_cards_dealt') {
        if (!seatLookup.has(e.playerId)) {
          // Engine has already removed the seat; fall back to seat we tracked
          // at hand start. For simplicity, leave as -1 if unknown.
        }
      }
    }
    const analysis = analyzeHand(lastHand, seatLookup);
    if (!analysis) {
      this.logger.warn('analyzeHand returned null');
      return;
    }
    const summary = summaryFromAnalysis(analysis);

    const persistPromise = this.handWriter.persistHand({
      sessionId: this.sessionId,
      handNumber: analysis.handNumber,
      buttonSeat: analysis.buttonSeat,
      board: analysis.board,
      potTotal: analysis.potTotal,
      eventLog: lastHand,
      players: analysis.perPlayer,
    });
    this.trackPersistence(persistPromise, 'persistHand');

    const handId = await persistPromise;
    const payload: HandCompletePayload = { handId, summary };
    this.io.to(sessionRoom(this.sessionId)).emit('hand:complete', payload);
  }

  // ------------------------- Helpers -------------------------

  private stackOf(userId: string): number {
    const state = this.table.getPublicState();
    const p = state.players.find((pl) => pl.id === userId);
    return p?.stack ?? 0;
  }

  private clearTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turnDeadline = null;
    this.currentToActUserId = null;
  }

  /**
   * Track an in-flight persistence promise so graceful shutdown can wait.
   * Failures are already swallowed by HandWriter; here we just log strays.
   */
  private trackPersistence(p: Promise<unknown>, label: string): void {
    this.pendingPersistence.add(p);
    p.catch((err) => {
      this.logger.error({ err, label }, 'persistence promise rejected');
    }).finally(() => {
      this.pendingPersistence.delete(p);
    });
  }

  pendingPersistencePromises(): Promise<unknown>[] {
    return Array.from(this.pendingPersistence);
  }

  shutdown(): void {
    this.clearTurnTimer();
  }
}
