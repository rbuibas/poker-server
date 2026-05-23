import type { Server } from 'socket.io';
import type { Logger } from '../logging.js';
import { SessionRuntime } from './SessionRuntime.js';
import type { ILoungeStore, LoungeRow } from '../persistence/lounges.js';
import type { ISessionStore } from '../persistence/sessions.js';
import type { IHandWriter } from '../persistence/handWriter.js';

export class SessionManager {
  private readonly byLoungeId = new Map<string, SessionRuntime>();
  private readonly logger: Logger;

  constructor(
    private readonly io: Server,
    logger: Logger,
    private readonly loungeStore: ILoungeStore,
    private readonly sessionStore: ISessionStore,
    private readonly handWriter: IHandWriter,
  ) {
    this.logger = logger.child({ component: 'SessionManager' });
  }

  get(loungeId: string): SessionRuntime | undefined {
    return this.byLoungeId.get(loungeId);
  }

  count(): number {
    return this.byLoungeId.size;
  }

  /**
   * Idempotent: returns existing runtime if a session is already active for
   * this lounge; otherwise creates a new session row and runtime.
   */
  async ensureSession(lounge: LoungeRow): Promise<SessionRuntime> {
    const existing = this.byLoungeId.get(lounge.id);
    if (existing) return existing;

    let sessionRow = await this.sessionStore.getActiveByLounge(lounge.id);
    if (!sessionRow) {
      sessionRow = await this.sessionStore.createSession(lounge.id);
    }
    const runtime = new SessionRuntime({
      io: this.io,
      logger: this.logger,
      lounge,
      sessionRow,
      handWriter: this.handWriter,
      sessionStore: this.sessionStore,
    });
    this.byLoungeId.set(lounge.id, runtime);
    this.logger.info({ loungeId: lounge.id, sessionId: sessionRow.id }, 'session started');
    return runtime;
  }

  /**
   * Called by the ConnectionManager when a user's last socket disconnects
   * (away=true) or first reconnects (away=false). Marks them away in any
   * session they happen to be seated in.
   */
  onPresenceChange(userId: string, present: boolean): void {
    for (const runtime of this.byLoungeId.values()) {
      if (runtime.seatOf(userId) === undefined) continue;
      runtime.markAway(userId, !present);
    }
  }

  /**
   * Wait for in-flight persistence promises across all runtimes (used at
   * graceful shutdown).
   */
  async awaitPendingPersistence(timeoutMs: number): Promise<void> {
    const promises: Promise<unknown>[] = [];
    for (const r of this.byLoungeId.values()) {
      promises.push(...r.pendingPersistencePromises());
    }
    if (promises.length === 0) return;
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  shutdown(): void {
    for (const r of this.byLoungeId.values()) r.shutdown();
  }
}
