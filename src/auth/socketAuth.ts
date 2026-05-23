import type { Server, Socket } from 'socket.io';
import type { Logger } from '../logging.js';
import { JwtVerifier } from './jwtVerifier.js';
import { userRoom } from '../connection/rooms.js';

export function installSocketAuth(
  io: Server,
  verifier: JwtVerifier,
  logger: Logger,
): void {
  io.use(async (socket: Socket, next: (err?: Error) => void) => {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    if (!token || typeof token !== 'string') {
      return next(new Error('auth_failed'));
    }
    try {
      const { userId } = await verifier.verify(token);
      socket.data.userId = userId;
      await socket.join(userRoom(userId));
      next();
    } catch (err) {
      logger.warn({ err }, 'socket auth failed');
      next(new Error('auth_failed'));
    }
  });
}
