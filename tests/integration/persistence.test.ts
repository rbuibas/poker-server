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

describe('hand persistence', () => {
  it('completed hand inserts hands + hand_players rows', async () => {
    const { userA, userB, loungeId, a, b } = await setupTwoPlayers(harness);
    autoplay(a, loungeId);
    autoplay(b, loungeId);

    a.emit('hand:start', { loungeId });
    await waitForEvent(a, 'hand:complete', 10_000);

    expect(harness.hands.hands.length).toBe(1);
    const hand = harness.hands.hands[0]!;
    expect(hand.hand_number).toBe(1);
    expect(Array.isArray(hand.event_log)).toBe(true);

    const players = harness.hands.handPlayers.filter((p) => p.hand_id === hand.id);
    expect(players.length).toBe(2);
    const userIds = new Set(players.map((p) => p.user_id));
    expect(userIds.has(userA)).toBe(true);
    expect(userIds.has(userB)).toBe(true);

    // Every player ends up in one of the four result categories.
    const counts = {
      won: players.filter((p) => p.result === 'won').length,
      lost: players.filter((p) => p.result === 'lost').length,
      folded: players.filter((p) => p.result === 'folded').length,
      split: players.filter((p) => p.result === 'split').length,
    };
    expect(counts.won + counts.lost + counts.folded + counts.split).toBe(2);
    // At least one player won (or both split).
    expect(counts.won + counts.split).toBeGreaterThanOrEqual(1);

    a.disconnect();
    b.disconnect();
  });
});
