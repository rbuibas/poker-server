import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  startTestServer,
  waitForConnect,
  waitForEvent,
  type TestHarness,
} from '../helpers/testClient.js';

let harness: TestHarness;
beforeEach(async () => {
  harness = await startTestServer();
});
afterEach(async () => {
  await harness.close();
});

describe('membership', () => {
  it('non-member trying to start a session gets not_member error', async () => {
    const ownerId = randomUUID();
    const lounge = harness.lounges.addLounge({ ownerId });
    const outsiderId = randomUUID();

    const sock = await harness.connectAs(outsiderId);
    await waitForConnect(sock);

    const errPromise = waitForEvent<{ code: string }>(sock, 'error');
    sock.emit('session:start', { loungeId: lounge.id });
    const err = await errPromise;
    expect(err.code).toBe('not_member');
    sock.disconnect();
  });
});
