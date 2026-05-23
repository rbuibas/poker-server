import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startTestServer,
  waitForEvent,
  type TestHarness,
} from '../helpers/testClient.js';
import { setupTwoPlayers } from '../helpers/twoPlayer.js';

let harness: TestHarness;
beforeEach(async () => {
  harness = await startTestServer();
});
afterEach(async () => {
  await harness.close();
});

describe('turn timer', () => {
  it('forceTimeout fires when a player does not act in time', async () => {
    // 1-second turn timer (server floor is also 1s). Neither side acts; both
    // get auto-folded/checked by forceTimeout — the hand resolves on its own.
    const { loungeId, a, b } = await setupTwoPlayers(harness, { turnTimerSeconds: 1 });

    // No autoplay handlers installed. Players never act. The server should
    // call forceTimeout on each turn, which folds them — and the hand will
    // end with the last non-folder taking the pot.
    const completed = waitForEvent(b, 'hand:complete', 15_000);
    a.emit('hand:start', { loungeId });
    const result = (await completed) as { summary: { handNumber: number } };
    expect(result.summary.handNumber).toBe(1);

    a.disconnect();
    b.disconnect();
  }, 30_000);
});
