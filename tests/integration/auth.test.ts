import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  mintJwt,
  startTestServer,
  waitForConnect,
  waitForConnectError,
  type TestHarness,
} from '../helpers/testClient.js';

let harness: TestHarness;
beforeEach(async () => {
  harness = await startTestServer();
});
afterEach(async () => {
  await harness.close();
});

describe('auth', () => {
  it('rejects connection with invalid JWT', async () => {
    const sock = await harness.connectWithToken('not-a-real-jwt');
    const err = await waitForConnectError(sock);
    expect(err.message).toMatch(/auth_failed/);
    sock.disconnect();
  });

  it('rejects connection with no token', async () => {
    const sock = await harness.connectWithToken('');
    const err = await waitForConnectError(sock);
    expect(err.message).toMatch(/auth_failed/);
    sock.disconnect();
  });

  it('accepts connection with valid JWT and joins user room', async () => {
    const userId = randomUUID();
    const token = await mintJwt(userId, harness.jwtSecret);
    const sock = await harness.connectWithToken(token);
    await waitForConnect(sock);
    expect(sock.connected).toBe(true);
    sock.disconnect();
  });
});
