import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renewDelayMs } from '../src/session.ts';

/** A token whose only meaningful claim is when it runs out. */
function tokenExpiring(expSeconds: number): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ sub: 'bot-1', exp: expSeconds })}.sig`;
}

// Realtime closes a topic the second its token runs out, so a bot that waits
// for a refusal before signing in again has already gone offline.
test('a session is renewed five minutes before it runs out', () => {
  const now = 1_800_000_000_000;
  const token = tokenExpiring(now / 1000 + 3600);
  assert.equal(renewDelayMs(token, now), (3600 - 300) * 1000);
});

test('a session nearly out is renewed soon, never in a tight loop', () => {
  const now = 1_800_000_000_000;
  assert.equal(renewDelayMs(tokenExpiring(now / 1000 + 60), now), 30_000);
  assert.equal(renewDelayMs(tokenExpiring(now / 1000 - 60), now), 30_000);
  assert.equal(renewDelayMs('not-a-jwt', now), 30_000);
});
