import { SignJWT } from 'jose';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import {
  InMemoryHandWriter,
  InMemoryLoungeStore,
  InMemorySessionStore,
} from './inMemoryStores.js';
import { buildServer, type AppServer } from '../../src/server.js';
import type { Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';

const JWT_SECRET = 'test-jwt-secret-do-not-use-anywhere-real-long-enough';

export async function mintJwt(userId: string, secret = JWT_SECRET): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

export interface TestHarness {
  app: AppServer;
  url: string;
  port: number;
  jwtSecret: string;
  lounges: InMemoryLoungeStore;
  sessions: InMemorySessionStore;
  hands: InMemoryHandWriter;
  connectAs(userId: string): Promise<ClientSocket>;
  connectWithToken(token: string): Promise<ClientSocket>;
  close(): Promise<void>;
}

export async function startTestServer(
  opts: { logLevel?: 'silent' | 'info' | 'debug'; jwtSecret?: string } = {},
): Promise<TestHarness> {
  const jwtSecret = opts.jwtSecret ?? JWT_SECRET;
  const lounges = new InMemoryLoungeStore();
  const sessions = new InMemorySessionStore();
  const hands = new InMemoryHandWriter(sessions);

  const config: Config = {
    PORT: 0,
    NODE_ENV: 'test',
    SUPABASE_URL: 'http://localhost',
    SUPABASE_SERVICE_ROLE_KEY: 'unused-by-tests',
    SUPABASE_JWT_SECRET: jwtSecret,
    ALLOWED_ORIGINS: '*',
    LOG_LEVEL: (opts.logLevel ?? 'silent') as Config['LOG_LEVEL'],
    DEV_NO_DB: false,
    allowedOriginList: ['*'],
  };

  const logger = createLogger(opts.logLevel ?? 'silent');
  const app = await buildServer(config, {
    loungeStore: lounges,
    sessionStore: sessions,
    handWriter: hands,
    logger,
  });
  const address = await app.fastify.listen({ host: '127.0.0.1', port: 0 });
  // address is like http://127.0.0.1:54321
  const url = typeof address === 'string' ? address : `http://127.0.0.1:${(address as { port: number }).port}`;
  const port = Number(new URL(url).port);

  const connectWithToken = async (token: string): Promise<ClientSocket> => {
    const sock = ioClient(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    return sock;
  };

  return {
    app,
    url,
    port,
    jwtSecret,
    lounges,
    sessions,
    hands,
    connectAs: async (userId: string) => {
      const token = await mintJwt(userId, jwtSecret);
      return connectWithToken(token);
    },
    connectWithToken,
    async close() {
      await app.close();
    },
  };
}

export function waitForEvent<T = unknown>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timeout waiting for "${event}" after ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = (payload: T): void => {
      clearTimeout(t);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

/**
 * Collect every emission of a given event until `untilEvent` arrives or
 * timeout, then return the collected payloads.
 */
export function collectEvents<T = unknown>(
  socket: ClientSocket,
  event: string,
): { stop: () => T[] } {
  const captured: T[] = [];
  const handler = (p: T): void => {
    captured.push(p);
  };
  socket.on(event, handler);
  return {
    stop: () => {
      socket.off(event, handler);
      return captured;
    },
  };
}

export async function waitForConnect(socket: ClientSocket, timeoutMs = 5_000): Promise<void> {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(t);
      resolve();
    });
    socket.once('connect_error', (err: Error) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

export async function waitForDisconnect(
  socket: ClientSocket,
  timeoutMs = 5_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('disconnect timeout')), timeoutMs);
    socket.once('disconnect', (reason: string) => {
      clearTimeout(t);
      resolve(reason);
    });
  });
}

/** Wait for the client to be rejected during the auth handshake. */
export async function waitForConnectError(
  socket: ClientSocket,
  timeoutMs = 5_000,
): Promise<Error> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect_error timeout')), timeoutMs);
    socket.once('connect_error', (err: Error) => {
      clearTimeout(t);
      resolve(err);
    });
  });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
