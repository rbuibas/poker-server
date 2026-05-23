import { randomUUID } from 'node:crypto';
import { waitForConnect, waitForEvent, type TestHarness } from './testClient.js';
import type { Socket as ClientSocket } from 'socket.io-client';

export interface TwoPlayerSetup {
  userA: string;
  userB: string;
  loungeId: string;
  a: ClientSocket;
  b: ClientSocket;
}

/**
 * Create a lounge, seat two clients (A at seat 0, B at seat 1), and return
 * the connected clients ready to start a hand. A is the lounge owner.
 *
 * Optionally pass settings overrides (e.g. for short turn timers in timer
 * tests).
 */
export async function setupTwoPlayers(
  harness: TestHarness,
  opts: { turnTimerSeconds?: number; buyIn?: number } = {},
): Promise<TwoPlayerSetup> {
  const userA = randomUUID();
  const userB = randomUUID();
  const lounge = harness.lounges.addLounge({
    ownerId: userA,
    settings: opts.turnTimerSeconds
      ? { turn_timer_seconds: opts.turnTimerSeconds }
      : undefined,
  });
  harness.lounges.addMember(lounge.id, userB);
  const buyIn = opts.buyIn ?? 1000;

  const a = await harness.connectAs(userA);
  const b = await harness.connectAs(userB);
  await Promise.all([waitForConnect(a), waitForConnect(b)]);

  // A starts session and sits at seat 0
  const aState = waitForEvent(a, 'session:state');
  a.emit('session:start', { loungeId: lounge.id });
  await aState;

  // B joins room
  const bState = waitForEvent(b, 'session:state');
  b.emit('session:join_room', { loungeId: lounge.id });
  await bState;

  // A sits down at seat 0
  const aJoinedOnB = waitForEvent(b, 'session:player_joined');
  a.emit('session:sit_down', { loungeId: lounge.id, seat: 0, buyIn });
  await aJoinedOnB;

  // B sits down at seat 1
  const bJoinedOnA = waitForEvent(a, 'session:player_joined');
  b.emit('session:sit_down', { loungeId: lounge.id, seat: 1, buyIn });
  await bJoinedOnA;

  return { userA, userB, loungeId: lounge.id, a, b };
}

/**
 * Install "always check/call" autoplay on a socket. Returns a stop fn.
 */
export function autoplay(
  socket: ClientSocket,
  loungeId: string,
): () => void {
  const handler = (p: { legalActions: { canCheck?: boolean; canCall?: boolean } }): void => {
    if (p.legalActions.canCheck) {
      socket.emit('hand:action', { loungeId, action: { type: 'check' } });
    } else if (p.legalActions.canCall) {
      socket.emit('hand:action', { loungeId, action: { type: 'call' } });
    } else {
      socket.emit('hand:action', { loungeId, action: { type: 'fold' } });
    }
  };
  socket.on('hand:your_turn', handler);
  return () => socket.off('hand:your_turn', handler);
}
