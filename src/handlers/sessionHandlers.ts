import type { Server, Socket } from 'socket.io';
import type { Logger } from '../logging.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { ILoungeStore } from '../persistence/lounges.js';
import { sessionRoom } from '../connection/rooms.js';
import { buildSessionState } from '../session/stateFiltering.js';
import { emitError, handleEngineError } from './errors.js';
import {
  SessionJoinRoomSchema,
  SessionKickSchema,
  SessionLeaveRoomSchema,
  SessionRebuySchema,
  SessionSitDownSchema,
  SessionSitOutSchema,
  SessionStandUpSchema,
  SessionStartSchema,
} from '../protocol/schemas.js';

export interface SessionHandlerDeps {
  io: Server;
  logger: Logger;
  loungeStore: ILoungeStore;
  sessions: SessionManager;
}

export function installSessionHandlers(socket: Socket, deps: SessionHandlerDeps): void {
  const userId = socket.data.userId as string;
  const { io, logger, loungeStore, sessions } = deps;
  const log = logger.child({ userId, socketId: socket.id });

  const withMembership = async (
    loungeId: string,
  ): Promise<{ ok: true; isOwner: boolean; lounge: Awaited<ReturnType<typeof loungeStore.getLounge>> } | { ok: false }> => {
    try {
      const result = await loungeStore.getLoungeForMember(loungeId, userId);
      if ('error' in result) {
        emitError(socket, result.error === 'not_found' ? 'not_member' : 'not_member', result.error);
        return { ok: false };
      }
      return { ok: true, isOwner: result.isOwner, lounge: result.lounge };
    } catch (err) {
      log.error({ err, loungeId }, 'membership check failed');
      emitError(socket, 'internal_error', 'membership check failed');
      return { ok: false };
    }
  };

  socket.on('session:start', async (raw: unknown) => {
    const parsed = SessionStartSchema.safeParse(raw);
    if (!parsed.success) return emitError(socket, 'invalid_action', 'invalid payload');
    const { loungeId } = parsed.data;
    const membership = await withMembership(loungeId);
    if (!membership.ok || !membership.lounge) return;
    try {
      const runtime = await sessions.ensureSession(membership.lounge);
      await socket.join(sessionRoom(runtime.sessionId));
      const snapshot = buildSessionState(runtime.table, runtime.summary(), userId);
      socket.emit('session:state', snapshot);
    } catch (err) {
      log.error({ err, loungeId }, 'session:start failed');
      emitError(socket, 'internal_error', 'failed to start session');
    }
  });

  socket.on('session:join_room', async (raw: unknown) => {
    const parsed = SessionJoinRoomSchema.safeParse(raw);
    if (!parsed.success) return emitError(socket, 'invalid_action', 'invalid payload');
    const { loungeId } = parsed.data;
    const membership = await withMembership(loungeId);
    if (!membership.ok) return;
    const runtime = sessions.get(loungeId);
    if (!runtime) return emitError(socket, 'no_active_session', 'no active session');
    await socket.join(sessionRoom(runtime.sessionId));
    socket.emit('session:state', buildSessionState(runtime.table, runtime.summary(), userId));
  });

  socket.on('session:leave_room', async (raw: unknown) => {
    const parsed = SessionLeaveRoomSchema.safeParse(raw);
    if (!parsed.success) return emitError(socket, 'invalid_action', 'invalid payload');
    const runtime = sessions.get(parsed.data.loungeId);
    if (!runtime) return;
    await socket.leave(sessionRoom(runtime.sessionId));
  });

  socket.on('session:sit_down', async (raw: unknown) => {
    const parsed = SessionSitDownSchema.safeParse(raw);
    if (!parsed.success) return emitError(socket, 'invalid_action', 'invalid payload');
    const { loungeId, seat, buyIn } = parsed.data;
    const membership = await withMembership(loungeId);
    if (!membership.ok) return;
    const runtime = sessions.get(loungeId);
    if (!runtime) return emitError(socket, 'no_active_session', 'no active session');
    try {
      runtime.sitDown(userId, seat, buyIn);
    } catch (err) {
      handleEngineError(socket, log, err, { op: 'sit_down', seat, buyIn });
    }
  });

  socket.on('session:stand_up', async (raw: unknown) => {
    const parsed = SessionStandUpSchema.safeParse(raw);
    if (!parsed.success) return emitError(socket, 'invalid_action', 'invalid payload');
    const runtime = sessions.get(parsed.data.loungeId);
    if (!runtime) return emitError(socket, 'no_active_session', 'no active session');
    try {
      runtime.standUp(userId, 'stood_up');
    } catch (err) {
      handleEngineError(socket, log, err, { op: 'stand_up' });
    }
  });

  socket.on('session:rebuy', async (raw: unknown) => {
    const parsed = SessionRebuySchema.safeParse(raw);
    if (!parsed.success) return emitError(socket, 'invalid_action', 'invalid payload');
    const runtime = sessions.get(parsed.data.loungeId);
    if (!runtime) return emitError(socket, 'no_active_session', 'no active session');
    try {
      runtime.rebuy(userId, parsed.data.amount);
    } catch (err) {
      handleEngineError(socket, log, err, { op: 'rebuy' });
    }
  });

  socket.on('session:sit_out', async (raw: unknown) => {
    const parsed = SessionSitOutSchema.safeParse(raw);
    if (!parsed.success) return emitError(socket, 'invalid_action', 'invalid payload');
    const runtime = sessions.get(parsed.data.loungeId);
    if (!runtime) return emitError(socket, 'no_active_session', 'no active session');
    try {
      runtime.setSitOut(userId, parsed.data.sitOut);
    } catch (err) {
      handleEngineError(socket, log, err, { op: 'sit_out' });
    }
  });

  socket.on('session:kick', async (raw: unknown) => {
    const parsed = SessionKickSchema.safeParse(raw);
    if (!parsed.success) return emitError(socket, 'invalid_action', 'invalid payload');
    const { loungeId, targetUserId } = parsed.data;
    const membership = await withMembership(loungeId);
    if (!membership.ok || !membership.lounge) return;
    if (!membership.isOwner) return emitError(socket, 'not_owner', 'lounge owner only');
    const runtime = sessions.get(loungeId);
    if (!runtime) return emitError(socket, 'no_active_session', 'no active session');
    if (runtime.isHandInProgress())
      return emitError(socket, 'hand_in_progress', 'cannot kick during a hand');
    try {
      runtime.standUp(targetUserId, 'kicked');
    } catch (err) {
      handleEngineError(socket, log, err, { op: 'kick', targetUserId });
    }
  });

  socket.on('ping', () => {
    socket.emit('pong', { t: Date.now() });
  });

  // io and userId are referenced by withMembership / kick checks above
  void io;
}
