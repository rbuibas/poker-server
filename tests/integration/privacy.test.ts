import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectEvents,
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

interface AnyEvent {
  type: string;
  playerId?: string;
  cards?: unknown;
}

describe('hole card privacy', () => {
  it('player B never receives player A\'s hole_cards_dealt event', async () => {
    const { userA, userB, loungeId, a, b } = await setupTwoPlayers(harness);

    // Collect every hand:event on player B's socket.
    const bEvents = collectEvents<AnyEvent>(b, 'hand:event');
    const aEvents = collectEvents<AnyEvent>(a, 'hand:event');

    autoplay(a, loungeId);
    autoplay(b, loungeId);

    a.emit('hand:start', { loungeId });
    await waitForEvent(b, 'hand:complete', 10_000);

    const bSeen = bEvents.stop();
    const aSeen = aEvents.stop();

    // Filter to hole_cards_dealt events visible to B.
    const bHoleEvents = bSeen.filter((e) => e.type === 'hole_cards_dealt');
    // B should have received exactly one hole_cards_dealt event — their own.
    expect(bHoleEvents.length).toBe(1);
    expect(bHoleEvents[0]!.playerId).toBe(userB);

    // Likewise for A.
    const aHoleEvents = aSeen.filter((e) => e.type === 'hole_cards_dealt');
    expect(aHoleEvents.length).toBe(1);
    expect(aHoleEvents[0]!.playerId).toBe(userA);

    // No event sent to B (anywhere) should carry A's hole cards directly
    // before showdown. Showdown reveals are public and allowed.
    const bEventsBeforeShowdown: AnyEvent[] = [];
    for (const e of bSeen) {
      if (e.type === 'showdown' || e.type === 'pot_awarded' || e.type === 'hand_complete') break;
      bEventsBeforeShowdown.push(e);
    }
    for (const e of bEventsBeforeShowdown) {
      if (e.type === 'hole_cards_dealt' && e.playerId === userA) {
        throw new Error('leak: B saw A\'s hole cards in hole_cards_dealt');
      }
    }

    a.disconnect();
    b.disconnect();
  });
});
