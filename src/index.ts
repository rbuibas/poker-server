import { config as loadDotenv } from 'dotenv';
import { SignJWT } from 'jose';
import { loadConfig } from './config.js';
import {
  buildServer,
  DEV_LOUNGE_ID,
  DEV_OWNER_ID,
  DEV_PLAYER2_ID,
} from './server.js';

if (process.env.NODE_ENV !== 'production') {
  loadDotenv();
}

async function mintDevJwt(secret: string, userId: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(key);
}

async function printDevBanner(jwtSecret: string, port: number): Promise<void> {
  const ownerJwt = await mintDevJwt(jwtSecret, DEV_OWNER_ID);
  const player2Jwt = await mintDevJwt(jwtSecret, DEV_PLAYER2_ID);
  const url = `http://localhost:${port}`;
  /* eslint-disable no-console */
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  DEV_NO_DB mode — no Supabase, in-memory stores only');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Lounge ID:   ${DEV_LOUNGE_ID}`);
  console.log(`  Owner ID:    ${DEV_OWNER_ID}`);
  console.log(`  Player 2 ID: ${DEV_PLAYER2_ID}`);
  console.log('');
  console.log('  Open two terminals in poker-server/ and paste one block each:');
  console.log('');
  console.log('  ── PLAYER 1 (owner) — PowerShell ──');
  console.log(`  $env:JWT='${ownerJwt}'`);
  console.log(`  $env:LOUNGE_ID='${DEV_LOUNGE_ID}'`);
  console.log(`  $env:SEAT='0'; $env:BUY_IN='1000'; $env:SERVER_URL='${url}'`);
  console.log('  npm run demo');
  console.log('');
  console.log('  ── PLAYER 2 — PowerShell ──');
  console.log(`  $env:JWT='${player2Jwt}'`);
  console.log(`  $env:LOUNGE_ID='${DEV_LOUNGE_ID}'`);
  console.log(`  $env:SEAT='1'; $env:BUY_IN='1000'; $env:SERVER_URL='${url}'`);
  console.log('  npm run demo');
  console.log('');
  console.log('  ── bash / Linux / macOS ──');
  console.log(`  JWT='${ownerJwt}' LOUNGE_ID=${DEV_LOUNGE_ID} SEAT=0 BUY_IN=1000 SERVER_URL=${url} npm run demo`);
  console.log(`  JWT='${player2Jwt}' LOUNGE_ID=${DEV_LOUNGE_ID} SEAT=1 BUY_IN=1000 SERVER_URL=${url} npm run demo`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  /* eslint-enable no-console */
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer(config);
  const port = config.PORT;

  await app.fastify.listen({ host: '0.0.0.0', port });
  app.logger.info({ port, devMode: config.DEV_NO_DB }, 'poker-server listening');

  if (config.DEV_NO_DB) {
    await printDevBanner(config.SUPABASE_JWT_SECRET, port);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.logger.info({ signal }, 'shutdown initiated');
    app.io.sockets.sockets.forEach((s) => {
      s.emit('error', { code: 'server_shutting_down', message: 'server restarting' });
    });
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error:', err);
  process.exit(1);
});
