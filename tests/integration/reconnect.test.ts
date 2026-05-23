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

describe('reconnect', () => {
  it('reconnected client receives session:state including own hole cards', async () => {
    const { userA, loungeId, a, b } = await setupTwoPlayers(harness);

    // Capture A's hole cards from the original hole_cards_dealt event.
    const aHole = waitForEvent<{ playerId: string; cards: unknown }>(a, 'hand:event', 10_000);

    // Make B autoplay-checks, but A waits without acting.
    a.emit('hand:start', { loungeId });

    let aHoleCards: unknown = null;
    // Capture the first hole_cards_dealt event A receives.
    await new Promise<void>((resolve) => {
      const handler = (evt: { type: string; cards?: unknown }): void => {
        if (evt.type === 'hole_cards_dealt') {
          aHoleCards = evt.cards;
          a.off('hand:event', handler);
          resolve();
        }
      };
      a.on('hand:event', handler);
    });
    void aHole;
    expect(aHoleCards).toBeTruthy();

    // Now disconnect A and reconnect with same userId.
    a.disconnect();
    // Small delay to let server process disconnect
    await new Promise((r) => setTimeout(r, 50));

    const token = await mintJwt(userA, harness.jwtSecret);
    const a2 = await harness.connectWithToken(token);
    await waitForConnect(a2);

    const statePromise = waitForEvent<{ table: { yourHoleCards: unknown } }>(a2, 'session:state');
    a2.emit('session:join_room', { loungeId });
    const state = await statePromise;
    expect(state.table.yourHoleCards).toBeTruthy();
    expect(JSON.stringify(state.table.yourHoleCards)).toEqual(JSON.stringify(aHoleCards));

    a2.disconnect();
    b.disconnect();
  });
});
