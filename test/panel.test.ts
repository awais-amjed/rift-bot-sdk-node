import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { Bot } from '../src/bot.ts';
import type { BotSession } from '../src/session.ts';

/**
 * What a panel row says about itself — WIRE.md §5. `live` puts a panel in the
 * bar above the channel's message box, so a panel must carry it exactly when
 * the bot asked, and never by default.
 */

const CHANNEL = 'cccccccc-0000-4000-8000-000000000001';

/** A session that records what the bot writes. */
function fakeSession() {
  const inserted: Record<string, unknown>[] = [];
  const patched: { query: string; body: Record<string, unknown> }[] = [];
  const session = {
    userId: 'bot-1',
    serverId: 'server-1',
    identity: { privateKey: generateKeyPairSync('ed25519').privateKey },
    async insertReturning(_table: string, row: Record<string, unknown>) {
      inserted.push(row);
      return [{ id: 7 }];
    },
    async patch(query: string, body: Record<string, unknown>) {
      patched.push({ query, body });
    },
  } as unknown as BotSession;
  return { session, inserted, patched };
}

const blocks = [{ type: 'heading', text: 'Now playing' }];

test('a live panel is written with live true', async () => {
  const { session, inserted, patched } = fakeSession();
  const bot = new Bot(session, 30_000, { realtime: false });

  await bot.panel(CHANNEL, blocks, { live: true });
  await bot.editPanel(CHANNEL, 7, blocks, { live: true });

  assert.deepEqual(inserted[0].blocks, { v: 1, live: true, blocks });
  assert.deepEqual(patched[0].body, { blocks: { v: 1, live: true, blocks } });
});

test('an edit without live leaves it out', async () => {
  const { session, inserted, patched } = fakeSession();
  const bot = new Bot(session, 30_000, { realtime: false });

  await bot.panel(CHANNEL, blocks);
  await bot.editPanel(CHANNEL, 7, blocks);
  await bot.editPanel(CHANNEL, 7, blocks, { live: false });

  assert.deepEqual(inserted[0].blocks, { v: 1, blocks });
  for (const { body } of patched) {
    assert.deepEqual(body, { blocks: { v: 1, blocks } });
  }
});
