import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Server as IoServer } from 'socket.io';
import type { Config } from './config.js';
import { createLogger, type Logger } from './logging.js';
import { JwtVerifier } from './auth/jwtVerifier.js';
import { installSocketAuth } from './auth/socketAuth.js';
import { ConnectionManager } from './connection/ConnectionManager.js';
import { SessionManager } from './session/SessionManager.js';
import { createAdminClient } from './persistence/supabaseAdmin.js';
import { LoungeStore, type ILoungeStore } from './persistence/lounges.js';
import { SessionStore, type ISessionStore } from './persistence/sessions.js';
import { HandWriter, type IHandWriter } from './persistence/handWriter.js';
import {
  InMemoryHandWriter,
  InMemoryLoungeStore,
  InMemorySessionStore,
} from './persistence/inMemoryStores.js';
import { installSessionHandlers } from './handlers/sessionHandlers.js';
import { installHandHandlers } from './handlers/handHandlers.js';

/** Hardcoded UUIDs for DEV_NO_DB mode — printed at boot for copy-paste. */
export const DEV_LOUNGE_ID = '00000000-0000-0000-0000-000000000001';
export const DEV_OWNER_ID = '00000000-0000-0000-0000-0000000000aa';
export const DEV_PLAYER2_ID = '00000000-0000-0000-0000-0000000000bb';

export interface AppServer {
  fastify: FastifyInstance;
  io: IoServer;
  logger: Logger;
  sessions: SessionManager;
  connections: ConnectionManager;
  /** Present only in DEV_NO_DB mode. Tests/dev use it to auto-add members. */
  devLounges?: InMemoryLoungeStore;
  close(): Promise<void>;
}

export interface BuildServerOpts {
  loungeStore?: ILoungeStore;
  sessionStore?: ISessionStore;
  handWriter?: IHandWriter;
  logger?: Logger;
}

export async function buildServer(config: Config, opts: BuildServerOpts = {}): Promise<AppServer> {
  const logger = opts.logger ?? createLogger(config.LOG_LEVEL);

  const fastify = Fastify({ logger: false, trustProxy: true });
  await fastify.register(cors, {
    origin: config.allowedOriginList,
    credentials: true,
  });

  let loungeStore: ILoungeStore;
  let sessionStore: ISessionStore;
  let handWriter: IHandWriter;
  let devLounges: InMemoryLoungeStore | undefined;

  if (opts.loungeStore && opts.sessionStore && opts.handWriter) {
    loungeStore = opts.loungeStore;
    sessionStore = opts.sessionStore;
    handWriter = opts.handWriter;
  } else if (config.DEV_NO_DB) {
    const memLounges = new InMemoryLoungeStore();
    const memSessions = new InMemorySessionStore();
    const memHands = new InMemoryHandWriter(memSessions);
    memLounges.addLounge({
      id: DEV_LOUNGE_ID,
      ownerId: DEV_OWNER_ID,
      name: 'Dev Lounge',
      settings: { turn_timer_seconds: 30, default_buy_in: 1000 },
    });
    devLounges = memLounges;
    loungeStore = memLounges;
    sessionStore = memSessions;
    handWriter = memHands;
  } else {
    const db = createAdminClient(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!);
    const realSessions = opts.sessionStore ?? new SessionStore(db);
    loungeStore = opts.loungeStore ?? new LoungeStore(db);
    sessionStore = realSessions;
    handWriter = opts.handWriter ?? new HandWriter(db, realSessions, logger);
  }

  const io = new IoServer(fastify.server, {
    cors: { origin: config.allowedOriginList, credentials: true },
    serveClient: false,
  });

  const verifier = new JwtVerifier(config.SUPABASE_JWT_SECRET);
  installSocketAuth(io, verifier, logger);

  const sessions = new SessionManager(io, logger, loungeStore, sessionStore, handWriter);
  const connections = new ConnectionManager(io, logger);
  connections.onPresenceChange((userId, present) => sessions.onPresenceChange(userId, present));

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;

    // In DEV_NO_DB mode, auto-add every authenticated user to the dev lounge
    // so they can immediately start a session without DB setup.
    if (devLounges && userId) {
      devLounges.addMember(DEV_LOUNGE_ID, userId);
    }

    logger.info({ userId, socketId: socket.id }, 'socket connected');
    connections.register(socket);
    installSessionHandlers(socket, { io, logger, loungeStore, sessions });
    installHandHandlers(socket, { io, logger, sessions });
    socket.on('disconnect', (reason) => {
      logger.info({ userId, socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  fastify.get('/health', async () => ({
    status: 'ok',
    activeSessions: sessions.count(),
    totalConnections: connections.totalConnections(),
    devMode: config.DEV_NO_DB,
  }));

  return {
    fastify,
    io,
    logger,
    sessions,
    connections,
    devLounges,
    async close() {
      sessions.shutdown();
      await sessions.awaitPendingPersistence(10_000);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await fastify.close();
    },
  };
}
