import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { io as ioClient } from 'socket.io-client';
import { buildServer, DEV_LOUNGE_ID, type AppServer } from '../../src/server.js';
import type { Config } from '../../src/config.js';
import { DEV_JWT_SECRET } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';
import { waitForConnect, waitForEvent } from '../helpers/testClient.js';

let app: AppServer;
let url: string;

beforeEach(async () => {
  const config: Config = {
    PORT: 0,
    NODE_ENV: 'test',
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SUPABASE_JWT_SECRET: DEV_JWT_SECRET,
    ALLOWED_ORIGINS: '*',
    LOG_LEVEL: 'silent',
    DEV_NO_DB: true,
    allowedOriginList: ['*'],
  };
  app = await buildServer(config, { logger: createLogger('silent') });
  const addr = await app.fastify.listen({ host: '127.0.0.1', port: 0 });
  url = typeof addr === 'string' ? addr : `http://127.0.0.1:${(addr as { port: number }).port}`;
});
afterEach(async () => {
  await app.close();
});

async function mintDevJwt(userId: string): Promise<string> {
  const key = new TextEncoder().encode(DEV_JWT_SECRET);
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

describe('DEV_NO_DB mode', () => {
  it('any authenticated user is auto-added to the dev lounge and can start a session', async () => {
    const userId = '12345678-1234-1234-1234-123456789abc'; // arbitrary uuid
    const token = await mintDevJwt(userId);
    const sock = ioClient(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    await waitForConnect(sock);
    const statePromise = waitForEvent<{ session: { loungeId: string } }>(sock, 'session:state');
    sock.emit('session:start', { loungeId: DEV_LOUNGE_ID });
    const state = await statePromise;
    expect(state.session.loungeId).toBe(DEV_LOUNGE_ID);
    expect(app.devLounges?.lounges.has(DEV_LOUNGE_ID)).toBe(true);
    expect(app.devLounges?.members.get(DEV_LOUNGE_ID)?.has(userId)).toBe(true);
    sock.disconnect();
  });
});
