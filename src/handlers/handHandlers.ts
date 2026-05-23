import type { Server, Socket } from 'socket.io';
import type { Logger } from '../logging.js';
import type { SessionManager } from '../session/SessionManager.js';
import { emitError, handleEngineError } from './errors.js';
import { HandActionSchema, HandStartSchema } from '../protocol/schemas.js';
import { TokenBucket } from './rateLimit.js';

export interface HandHandlerDeps {
  io: Server;
  logger: Logger;
  sessions: SessionManager;
}

export function installHandHandlers(socket: Socket, deps: HandHandlerDeps): void {
  const userId = socket.data.userId as string;
  const { logger, sessions } = deps;
  const log = logger.child({ userId, socketId: socket.id });

  const bucket = new TokenBucket();

  socket.on('hand:start', async (raw: unknown) => {
    const parsed = HandStartSchema.safeParse(raw);
    if (!parsed.success) return emitError(socket, 'invalid_action', 'invalid payload');
    const runtime = sessions.get(parsed.data.loungeId);
    if (!runtime) return emitError(socket, 'no_active_session', 'no active session');
    if (runtime.seatOf(userId) === undefined)
      return emitError(socket, 'invalid_action', 'not seated');
    const check = runtime.table.canStartHand();
    if (!check.ok)
      return emitError(socket, 'invalid_action', check.reason ?? 'cannot start hand');
    try {
      runtime.startHand();
    } catch (err) {
      handleEngineError(socket, log, err, { op: 'hand_start' });
    }
  });

  socket.on('hand:action', async (raw: unknown) => {
    if (!bucket.tryConsume(1)) return; // silently drop excess actions
    const parsed = HandActionSchema.safeParse(raw);
    if (!parsed.success) return emitError(socket, 'invalid_action', 'invalid payload');
    const runtime = sessions.get(parsed.data.loungeId);
    if (!runtime) return emitError(socket, 'no_active_session', 'no active session');
    try {
      runtime.handleAction(userId, parsed.data.action);
    } catch (err) {
      handleEngineError(socket, log, err, { op: 'hand_action' });
    }
  });
}
