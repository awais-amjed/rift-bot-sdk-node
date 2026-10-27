import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RealtimeListener, type Socketish } from '../src/realtime.ts';

/**
 * The listener a bot hears its server through.
 *
 * Every case here is something that fails silently in production: a join the
 * server refuses, a frame for another topic acted on, a token that expired
 * without the socket being told. A bot that stops hearing looks exactly like a
 * server where nothing is happening.
 */

/** A socket the test drives: what was sent, and what arrives. */
class FakeSocket implements Socketish {
  readyState = 1;
  readonly sent: Record<string, any>[] = [];
  readonly #listeners = new Map<string, (event: any) => void>();

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.#listeners.get('close')?.({});
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    this.#listeners.set(type, listener);
  }

  open(): void {
    this.#listeners.get('open')?.({});
  }

  deliver(frame: unknown): void {
    this.#listeners.get('message')?.({ data: JSON.stringify(frame) });
  }

  /** The join frame, or undefined when it never joined. */
  get join(): Record<string, any> | undefined {
    return this.sent.find((message) => message.event === 'phx_join');
  }
}

function listener(overrides: Partial<Parameters<typeof build>[0]> = {}) {
  return build({
    events: [],
    errors: [],
    ...overrides,
  } as any);
}

function build(state: { events: any[]; errors: Error[] }) {
  const socket = new FakeSocket();
  const subject = new RealtimeListener({
    url: 'https://server.invalid',
    anonKey: 'sb_publishable_test',
    token: 'jwt-1',
    topic: 'user:bot-1',
    onEvent: (event) => state.events.push(event),
    onError: (error) => state.errors.push(error),
    connect: () => socket,
  });
  return { subject, socket, state };
}

test('the join is private and carries the token the rules are checked against', () => {
  const { subject, socket } = listener();
  subject.start();
  socket.open();

  assert.equal(socket.join?.topic, 'realtime:user:bot-1');
  assert.equal(socket.join?.payload.config.private, true);
  assert.equal(socket.join?.payload.access_token, 'jwt-1');
});

test('a broadcast arrives as its event and its ids', () => {
  const { subject, socket, state } = listener();
  subject.start();
  socket.open();

  socket.deliver({
    topic: 'realtime:user:bot-1',
    event: 'broadcast',
    payload: { event: 'message', payload: { id: 7, channel_id: 'c1' } },
  });

  assert.deepEqual(state.events, [
    { event: 'message', payload: { id: 7, channel_id: 'c1' } },
  ]);
});

test('a frame for another topic is not ours to act on', () => {
  const { subject, socket, state } = listener();
  subject.start();
  socket.open();

  socket.deliver({
    topic: 'realtime:user:someone-else',
    event: 'broadcast',
    payload: { event: 'message', payload: { id: 7 } },
  });

  assert.deepEqual(state.events, []);
});

// A refused join answers on the socket instead of closing it, so without this
// the bot sits on a topic it never joined, hearing nothing and saying nothing.
test('a refused join is reported', () => {
  const { subject, socket, state } = listener();
  subject.start();
  socket.open();

  socket.deliver({
    topic: 'realtime:user:bot-1',
    event: 'phx_reply',
    payload: { status: 'error', response: { reason: 'unauthorized' } },
  });

  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0].message, /unauthorized/);
});

test('a new token is sent to the topic already joined', () => {
  const { subject, socket } = listener();
  subject.start();
  socket.open();
  socket.deliver({ topic: 'realtime:user:bot-1', event: 'phx_reply', ref: socket.join?.ref, payload: { status: 'ok' } });

  subject.setToken('jwt-2');

  const refresh = socket.sent.find((message) => message.event === 'access_token');
  assert.equal(refresh?.payload.access_token, 'jwt-2');
});

test('a token set while disconnected is the one the next join uses', () => {
  const { subject, socket } = listener();
  subject.setToken('jwt-2');
  subject.start();
  socket.open();

  assert.equal(socket.join?.payload.access_token, 'jwt-2');
  assert.equal(
    socket.sent.some((message) => message.event === 'access_token'),
    false,
  );
});

test('garbage on the socket is ignored', () => {
  const { subject, socket, state } = listener();
  subject.start();
  socket.open();

  socket.deliver('not a frame');
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.errors, []);
});

test('stopping does not reconnect', () => {
  const { subject, socket } = listener();
  subject.start();
  socket.open();
  subject.stop();

  assert.equal(subject.connected, false);
});

function presenceListener() {
  const socket = new FakeSocket();
  const subject = new RealtimeListener({
    url: 'https://server.invalid',
    anonKey: 'sb_publishable_test',
    token: 'jwt-1',
    topic: 'presence:server-1',
    presence: { userId: 'bot-1', displayName: 'DJ Riff' },
    onEvent: () => {},
    connect: () => socket,
  });
  return { subject, socket };
}

const tracks = (socket: FakeSocket) =>
  socket.sent.filter((message) => message.event === 'presence');

test('a listener with presence tracks it once its join is accepted', () => {
  const { subject, socket } = presenceListener();
  subject.start();
  socket.open();

  assert.equal(socket.join?.payload.config.presence.enabled, true);
  assert.equal(tracks(socket).length, 0, 'not before the server has said yes');

  socket.deliver({ topic: 'realtime:presence:server-1', event: 'phx_reply', ref: socket.join?.ref, payload: { status: 'ok' } });

  const [track] = tracks(socket);
  assert.equal(track.topic, 'realtime:presence:server-1');
  assert.deepEqual(track.payload, {
    type: 'presence',
    event: 'track',
    payload: { userId: 'bot-1', displayName: 'DJ Riff' },
  });
});

test('presence is not tracked off a reply to something other than the join', () => {
  const { subject, socket } = presenceListener();
  subject.start();
  socket.open();
  socket.deliver({ topic: 'realtime:presence:server-1', event: 'phx_reply', ref: 'not-the-join', payload: { status: 'ok' } });
  socket.deliver({ topic: 'realtime:presence:server-1', event: 'phx_reply', ref: socket.join?.ref, payload: { status: 'error', response: { reason: 'no' } } });
  assert.equal(tracks(socket).length, 0);
});

test('a listener without presence joins with it off and never tracks', () => {
  const { subject, socket } = listener();
  subject.start();
  socket.open();
  socket.deliver({ topic: 'realtime:user:bot-1', event: 'phx_reply', ref: socket.join?.ref, payload: { status: 'ok' } });

  assert.equal(socket.join?.payload.config.presence.enabled, false);
  assert.equal(tracks(socket).length, 0);
});

// ── A topic the server closes ──────────────────────────────────────────────
//
// Realtime closes a topic the moment its token runs out — "Token has expired"
// then `phx_close` — and leaves the socket open. A new token pushed to it then
// answers "unmatched topic". A bot that only pushed went offline an hour after
// every start and stayed that way (seen on a live server Oct 27).

const joins = (socket: FakeSocket) =>
  socket.sent.filter((message) => message.event === 'phx_join');

function closeTopic(socket: FakeSocket, topic: string): void {
  socket.deliver({
    topic,
    event: 'system',
    payload: { message: 'Token has expired 0 seconds ago', status: 'error', extension: 'system' },
  });
  socket.deliver({ topic, event: 'phx_close', payload: {} });
}

test('a topic the server closes is joined again, and its presence tracked again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { subject, socket } = presenceListener();
  subject.start();
  socket.open();
  socket.deliver({ topic: 'realtime:presence:server-1', event: 'phx_reply', ref: socket.join?.ref, payload: { status: 'ok' } });
  assert.equal(subject.connected, true);

  closeTopic(socket, 'realtime:presence:server-1');
  assert.equal(subject.connected, false, 'a closed topic is not joined');

  t.mock.timers.tick(1_000);
  const rejoin = joins(socket).at(-1);
  assert.equal(joins(socket).length, 2);
  socket.deliver({ topic: 'realtime:presence:server-1', event: 'phx_reply', ref: rejoin?.ref, payload: { status: 'ok' } });

  assert.equal(tracks(socket).length, 2);
  assert.equal(subject.connected, true);
});

test('a new token reaches a closed topic as a join, not an update', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { subject, socket } = listener();
  subject.start();
  socket.open();
  socket.deliver({ topic: 'realtime:user:bot-1', event: 'phx_reply', ref: socket.join?.ref, payload: { status: 'ok' } });
  closeTopic(socket, 'realtime:user:bot-1');

  subject.setToken('jwt-2');

  assert.equal(joins(socket).at(-1)?.payload.access_token, 'jwt-2');
  assert.equal(socket.sent.some((message) => message.event === 'access_token'), false);
  t.mock.timers.tick(30_000);
  assert.equal(joins(socket).length, 2, 'and not joined twice');
});

test('an update the server no longer knows the topic for joins it again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { subject, socket, state } = listener();
  subject.start();
  socket.open();
  socket.deliver({ topic: 'realtime:user:bot-1', event: 'phx_reply', ref: socket.join?.ref, payload: { status: 'ok' } });
  subject.setToken('jwt-2');
  const update = socket.sent.find((message) => message.event === 'access_token');

  socket.deliver({ topic: 'realtime:user:bot-1', event: 'phx_reply', ref: update?.ref, payload: { status: 'error', response: { reason: 'unmatched topic' } } });
  t.mock.timers.tick(1_000);

  assert.equal(joins(socket).at(-1)?.payload.access_token, 'jwt-2');
  assert.equal(joins(socket).length, 2);
  assert.deepEqual(state.errors, [], 'nothing wrong worth reporting');
});
