import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mintJwt,
  startTestServer,
  waitForConnect,
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

describe('multi-tab', () => {
  it('both sockets for the same user receive hand:your_turn', async () => {
    const { userA, loungeId, a, b } = await setupTwoPlayers(harness);

    // Open a second tab for user A.
    const token = await mintJwt(userA, harness.jwtSecret);
    const a2 = await harness.connectWithToken(token);
    await waitForConnect(a2);
    a2.emit('session:join_room', { loungeId });
    await waitForEvent(a2, 'session:state');

    // B autoplays so the hand progresses; A's two tabs both should receive
    // hand:your_turn when it's A's turn.
    b.on('hand:your_turn', (p: { legalActions: { canCheck?: boolean; canCall?: boolean } }) => {
      if (p.legalActions.canCheck) {
        b.emit('hand:action', { loungeId, action: { type: 'check' } });
      } else if (p.legalActions.canCall) {
        b.emit('hand:action', { loungeId, action: { type: 'call' } });
      } else {
        b.emit('hand:action', { loungeId, action: { type: 'fold' } });
      }
    });

    const turnOnA = waitForEvent(a, 'hand:your_turn', 5_000);
    const turnOnA2 = waitForEvent(a2, 'hand:your_turn', 5_000);

    a.emit('hand:start', { loungeId });
    const [t1, t2] = await Promise.all([turnOnA, turnOnA2]);
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();

    a.disconnect();
    a2.disconnect();
    b.disconnect();
  });
});
