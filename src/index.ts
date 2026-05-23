import { config as loadDotenv } from 'dotenv';
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

function printDevBanner(port: number): void {
  const url = `http://localhost:${port}`;
  /* eslint-disable no-console */
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  DEV_NO_DB mode — no Supabase, in-memory stores only');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Server:      ${url}`);
  console.log(`  Lounge ID:   ${DEV_LOUNGE_ID}`);
  console.log(`  Owner ID:    ${DEV_OWNER_ID}`);
  console.log(`  Player 2 ID: ${DEV_PLAYER2_ID}`);
  console.log('');
  console.log('  ▶ Open two more terminals in poker-server/ and run:');
  console.log('    Terminal 2:  npm run dev:p1');
  console.log('    Terminal 3:  npm run dev:p2');
  console.log('');
  console.log('  Each script auto-mints its JWT and joins the dev lounge.');
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
    printDevBanner(port);
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
