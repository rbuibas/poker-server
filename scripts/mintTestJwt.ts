#!/usr/bin/env tsx
// Mints a Supabase-compatible JWT for local testing / demo CLI.
// Usage: tsx scripts/mintTestJwt.ts <userId> [--exp <seconds>]
import { config as loadDotenv } from 'dotenv';
import { SignJWT } from 'jose';

loadDotenv();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const userId = args[0];
  if (!userId) {
    console.error('Usage: tsx scripts/mintTestJwt.ts <userId> [--exp <seconds>]');
    process.exit(1);
  }
  const expIdx = args.indexOf('--exp');
  const expSeconds = expIdx >= 0 && args[expIdx + 1] ? Number(args[expIdx + 1]) : 3600;

  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    console.error('SUPABASE_JWT_SECRET not set (check your .env)');
    process.exit(1);
  }
  const key = new TextEncoder().encode(secret);
  const jwt = await new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(`${expSeconds}s`)
    .sign(key);

  process.stdout.write(jwt + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
