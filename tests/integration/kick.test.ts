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

describe('kick', () => {
  it('owner can kick a member between hands', async () => {
    const { userB, loungeId, a, b } = await setupTwoPlayers(harness);

    const leftEvt = waitForEvent<{ userId: string; reason: string }>(
      b,
      'session:player_left',
    );
    a.emit('session:kick', { loungeId, targetUserId: userB });
    const evt = await leftEvt;
    expect(evt.userId).toBe(userB);
    expect(evt.reason).toBe('kicked');

    a.disconnect();
    b.disconnect();
  });

  it('owner cannot kick during a hand', async () => {
    // Short turn timer so the hand resolves via forceTimeout after the test.
    const { userB, loungeId, a, b } = await setupTwoPlayers(harness, {
      turnTimerSeconds: 1,
    });

    a.emit('hand:start', { loungeId });
    await Promise.race([
      waitForEvent(a, 'hand:your_turn', 5_000),
      waitForEvent(b, 'hand:your_turn', 5_000),
    ]);

    const errPromise = waitForEvent<{ code: string }>(a, 'error');
    a.emit('session:kick', { loungeId, targetUserId: userB });
    const err = await errPromise;
    expect(err.code).toBe('hand_in_progress');

    // Let forceTimeout wind the hand down so we don't dangle resources.
    autoplay(a, loungeId);
    autoplay(b, loungeId);
    await waitForEvent(a, 'hand:complete', 10_000);

    a.disconnect();
    b.disconnect();
  }, 20_000);
});
