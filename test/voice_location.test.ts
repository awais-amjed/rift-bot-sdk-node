import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BotError, type BotSession } from '../src/session.ts';
import { VoiceConnection } from '../src/voice.ts';
import {
  VOICE_LOCATION_EVENT,
  VoicePlaces,
  announcePlace,
  voiceLocation,
} from '../src/voice_location.ts';

/** A session that records its broadcasts, and can refuse the first one. */
function fakeSession(refuseFirstWith?: number) {
  const sent: { topic: string; event: string; payload: Record<string, unknown> }[] = [];
  let logins = 0;
  let refuse = refuseFirstWith;
  const session = {
    userId: 'bot-1',
    serverId: 'server-1',
    async broadcast(topic: string, event: string, payload: Record<string, unknown>) {
      if (refuse !== undefined) {
        const status = refuse;
        refuse = undefined;
        throw new BotError(`${status}`, status);
      }
      sent.push({ topic, event, payload });
    },
    async login() {
      logins++;
    },
  } as unknown as BotSession;
  return { session, sent, logins: () => logins };
}

class FakeRoom {
  #onDisconnected: (() => void) | null = null;
  async disconnect(): Promise<void> {
    this.end();
  }
  once(_event: 'disconnected', listener: () => void): void {
    this.#onDisconnected = listener;
  }
  end(): void {
    const listener = this.#onDisconnected;
    this.#onDisconnected = null;
    listener?.();
  }
}

test('the message is the app\'s: here, {v: 1, userId, channelId}', () => {
  assert.equal(VOICE_LOCATION_EVENT, 'here');
  assert.deepEqual(voiceLocation('u', 'c'), { v: 1, userId: 'u', channelId: 'c' });
  assert.deepEqual(voiceLocation('u', null), { v: 1, userId: 'u', channelId: null });
});

test('a bot in two calls is drawn in the newest, and leaves to the one before', () => {
  const places = new VoicePlaces();
  assert.equal(places.enter('a'), 'a');
  assert.equal(places.enter('b'), 'b');
  assert.equal(places.leave('b'), 'a');
  assert.equal(places.leave('a'), null);
  // Leaving somewhere it never was moves nothing.
  assert.equal(places.leave('z'), null);
});

test('two connections to one channel: leaving one keeps it there', () => {
  const places = new VoicePlaces();
  places.enter('a');
  places.enter('a');
  assert.equal(places.leave('a'), 'a');
  assert.equal(places.leave('a'), null);
});

test('joining and then leaving says both, in that order, on voice:<server>', async () => {
  // The ghost: a bot that left without a word stayed drawn in the channel for
  // every member who had read the roster while it was there.
  const { session, sent } = fakeSession();
  const room = new FakeRoom();
  const voice = new VoiceConnection('chan', false, {} as never, room, 0, session);
  void announcePlace(session, (p) => p.enter('chan'));
  await voice.leave();
  assert.deepEqual(sent, [
    { topic: 'voice:server-1', event: 'here', payload: { v: 1, userId: 'bot-1', channelId: 'chan' } },
    { topic: 'voice:server-1', event: 'here', payload: { v: 1, userId: 'bot-1', channelId: null } },
  ]);
});

test('a room the server ends is announced as a leave too', async () => {
  const { session, sent } = fakeSession();
  const room = new FakeRoom();
  const voice = new VoiceConnection('chan', false, {} as never, room, 0, session);
  void announcePlace(session, (p) => p.enter('chan'));
  room.end();
  await voice.closed;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent.map((m) => m.payload.channelId), ['chan', null]);
});

test('an expired session signs in again and says it once more', async () => {
  const { session, sent, logins } = fakeSession(401);
  await announcePlace(session, (p) => p.enter('chan'));
  assert.equal(logins(), 1);
  assert.equal(sent.length, 1);
});

test('any other failure is swallowed: a leave never fails over the message', async () => {
  const { session, sent } = fakeSession(500);
  await announcePlace(session, (p) => p.enter('chan'));
  assert.equal(sent.length, 0);
});
