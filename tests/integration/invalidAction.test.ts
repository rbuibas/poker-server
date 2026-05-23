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

describe('invalid action', () => {
  it('player gets not_your_turn when acting out of turn', async () => {
    // Use short timer so the hand auto-resolves after the assertion.
    const { loungeId, a, b } = await setupTwoPlayers(harness, { turnTimerSeconds: 1 });

    // Track which player got the turn first; the OTHER one acts wrongly.
    const turnArrived: Promise<'A' | 'B'> = new Promise((resolve) => {
      a.once('hand:your_turn', () => resolve('A'));
      b.once('hand:your_turn', () => resolve('B'));
    });

    a.emit('hand:start', { loungeId });
    const firstTurn = await turnArrived;
    const wrong = firstTurn === 'A' ? b : a;
    const errPromise = waitForEvent<{ code: string }>(wrong, 'error');
    wrong.emit('hand:action', { loungeId, action: { type: 'fold' } });
    const err = await errPromise;
    expect(err.code).toBe('not_your_turn');

    // Let the engine wind the hand down via forceTimeout (turn_timer=1s).
    autoplay(a, loungeId);
    autoplay(b, loungeId);
    await waitForEvent(a, 'hand:complete', 10_000);
    void autoplay; // ensure import used
    a.disconnect();
    b.disconnect();
  }, 20_000);
});
