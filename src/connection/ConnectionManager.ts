import type { Server, Socket } from 'socket.io';
import type { Logger } from '../logging.js';

export type PresenceListener = (userId: string, present: boolean) => void;

export class ConnectionManager {
  private readonly userIdToSockets = new Map<string, Set<Socket>>();
  private readonly listeners: PresenceListener[] = [];

  constructor(
    private readonly io: Server,
    private readonly logger: Logger,
  ) {}

  onPresenceChange(listener: PresenceListener): void {
    this.listeners.push(listener);
  }

  register(socket: Socket): void {
    const userId = socket.data.userId as string | undefined;
    if (!userId) {
      this.logger.error({ socketId: socket.id }, 'register: missing userId');
      return;
    }
    let set = this.userIdToSockets.get(userId);
    if (!set) {
      set = new Set();
      this.userIdToSockets.set(userId, set);
    }
    const wasEmpty = set.size === 0;
    set.add(socket);

    socket.on('disconnect', () => this.unregister(socket));

    if (wasEmpty) {
      this.notify(userId, true);
    }
  }

  private unregister(socket: Socket): void {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;
    const set = this.userIdToSockets.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) {
      this.userIdToSockets.delete(userId);
      this.notify(userId, false);
    }
  }

  private notify(userId: string, present: boolean): void {
    for (const l of this.listeners) {
      try {
        l(userId, present);
      } catch (err) {
        this.logger.error({ err }, 'presence listener threw');
      }
    }
  }

  isOnline(userId: string): boolean {
    const set = this.userIdToSockets.get(userId);
    return !!set && set.size > 0;
  }

  totalConnections(): number {
    let n = 0;
    for (const s of this.userIdToSockets.values()) n += s.size;
    return n;
  }
}
