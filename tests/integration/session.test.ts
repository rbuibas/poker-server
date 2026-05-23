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

describe('session lifecycle', () => {
  it('starts a session and emits session:state to the requester', async () => {
    const ownerId = randomUUID();
    const lounge = harness.lounges.addLounge({ ownerId });

    const sock = await harness.connectAs(ownerId);
    await waitForConnect(sock);
    const statePromise = waitForEvent(sock, 'session:state');
    sock.emit('session:start', { loungeId: lounge.id });
    const state = (await statePromise) as { session: { loungeId: string } };
    expect(state.session.loungeId).toBe(lounge.id);
    expect(harness.sessions.sessions.size).toBe(1);
    sock.disconnect();
  });

  it('two players sitting down each broadcast player_joined', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const lounge = harness.lounges.addLounge({ ownerId: userA });
    harness.lounges.addMember(lounge.id, userB);

    const a = await harness.connectAs(userA);
    const b = await harness.connectAs(userB);
    await Promise.all([waitForConnect(a), waitForConnect(b)]);

    // A starts the session
    const aState = waitForEvent(a, 'session:state');
    a.emit('session:start', { loungeId: lounge.id });
    await aState;

    // B joins room
    const bState = waitForEvent(b, 'session:state');
    b.emit('session:join_room', { loungeId: lounge.id });
    await bState;

    // A sits at seat 0
    const aJoined = waitForEvent(b, 'session:player_joined');
    a.emit('session:sit_down', { loungeId: lounge.id, seat: 0, buyIn: 1000 });
    const evt1 = (await aJoined) as { userId: string; seat: number };
    expect(evt1.userId).toBe(userA);
    expect(evt1.seat).toBe(0);

    // B sits at seat 1
    const bJoined = waitForEvent(a, 'session:player_joined');
    b.emit('session:sit_down', { loungeId: lounge.id, seat: 1, buyIn: 1000 });
    const evt2 = (await bJoined) as { userId: string; seat: number };
    expect(evt2.userId).toBe(userB);
    expect(evt2.seat).toBe(1);

    a.disconnect();
    b.disconnect();
  });
});
