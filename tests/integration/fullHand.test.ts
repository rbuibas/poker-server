import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startTestServer,
  waitForEvent,
  type TestHarness,
} from '../helpers/testClient.js';
import { autoplay, setupTwoPlayers } from '../helpers/twoPlayer.js';

let harness: TestHarness;
beforeEach(async () => {
  harness = await startTestServer();
});
afterEach(async () => {
  await harness.close();
});

describe('full hand', () => {
  it('two players play a full hand to completion', async () => {
    const { loungeId, a, b } = await setupTwoPlayers(harness);
    autoplay(a, loungeId);
    autoplay(b, loungeId);

    const handCompleteA = waitForEvent<{ summary: { handNumber: number } }>(
      a,
      'hand:complete',
      10_000,
    );
    a.emit('hand:start', { loungeId });
    const result = await handCompleteA;
    expect(result.summary.handNumber).toBe(1);

    // Persistence is in-memory; expect a row.
    expect(harness.hands.hands.length).toBe(1);
    expect(harness.hands.handPlayers.length).toBe(2);
    expect(harness.hands.hands[0]!.session_id).toBeDefined();

    a.disconnect();
    b.disconnect();
  });
});
