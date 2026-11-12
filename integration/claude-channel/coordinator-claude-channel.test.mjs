// End-to-end: KanBorg-side adapter ⇄ the plugin's real wake channel.
// Run: node --experimental-strip-types --test integration/claude-channel/coordinator-claude-channel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClaudeChannelAdapter, CLAUDE_CHANNEL_ADAPTER_ID } from './coordinator-claude-channel.ts';
import { WakeChannel } from '../../plugins/kanborg-connect-claude/wake/server.mjs';

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'kbc-'));
  const chatId = randomUUID();
  const out = [];
  const channel = new WakeChannel({ root, chatId, out: (m) => out.push(m), client: null });
  await channel.openInbox();
  const adapter = createClaudeChannelAdapter({ registryDir: join(root, 'sessions') });
  const binding = { id: 'b-1', clientId: 'client-1', hostId: 'local', chatId, adapterId: CLAUDE_CHANNEL_ADAPTER_ID, state: 'approved' };
  return { root, chatId, out, channel, adapter, binding };
};
const signal = (o = {}) => ({ id: randomUUID(), workspaceId: 'ws-1', clientId: 'client-1', epoch: 2, kind: 'coordinator-request', cursor: 10, ...o });

test('reachable → send → reconcile against a live channel', async () => {
  const { out, channel, adapter, binding, chatId } = await setup();
  try {
    assert.equal((await adapter.reachable(binding)).state, 'available');
    const s = signal({ handoffId: 'h-1' });
    const d = await adapter.send(binding, s);
    assert.equal(d.state, 'accepted');
    assert.equal(d.receipt, `claude-channel:${chatId}:${s.id}`);
    assert.equal(out.length, 1);
    assert.equal(out[0].method, 'notifications/claude/channel');
    assert.equal(out[0].params.meta.kind, 'coordinator-request');
    assert.equal((await adapter.reconcile(binding, s.id)).state, 'accepted', 'reconcile without stored receipt asks the channel');
    assert.equal((await adapter.reconcile(binding, s.id, d.receipt)).state, 'accepted');
    assert.equal((await adapter.reconcile(binding, randomUUID())).state, 'unknown');
    assert.equal((await adapter.send(binding, s)).receipt, d.receipt);
    assert.equal(out.length, 1, 'resend of the same event does not wake twice');
  } finally { channel.close(); }
});

test('offline, revoked, foreign binding and wrong client', async () => {
  const { channel, adapter, binding } = await setup();
  channel.close();
  assert.equal((await adapter.reachable(binding)).state, 'offline');
  assert.equal((await adapter.send(binding, signal())).state, 'not-delivered');
  assert.equal((await adapter.reachable({ ...binding, state: 'revoked' })).state, 'revoked');
  assert.equal((await adapter.reachable({ ...binding, adapterId: 'codex-cli-queue-v1' })).state, 'unsupported');
  assert.equal((await adapter.send(binding, signal({ clientId: 'someone-else' }))).state, 'not-delivered');
});

test('rejects registry files other users could read or redirect', async () => {
  const { channel, adapter, binding } = await setup();
  try {
    chmodSync(channel.registryPath, 0o644);
    assert.equal((await adapter.reachable(binding)).state, 'unknown');
    chmodSync(channel.registryPath, 0o600);
    const reg = JSON.parse(readFileSync(channel.registryPath, 'utf8'));
    writeFileSync(channel.registryPath, JSON.stringify({ ...reg, socket: '/tmp/elsewhere.sock' }), { mode: 0o600 });
    assert.equal((await adapter.reachable(binding)).state, 'unknown');
    assert.equal((await adapter.send(binding, signal())).state, 'not-delivered');
  } finally { channel.close(); }
});

test('a reply lost after the request was written is unknown, not retried as undelivered', async () => {
  const { channel, binding, root } = await setup();
  try {
    const adapter = createClaudeChannelAdapter({ registryDir: join(root, 'sessions'),
      exchange: async () => { throw Object.assign(Error('timeout'), { sent: true }); } });
    assert.equal((await adapter.send(binding, signal())).state, 'unknown');
  } finally { channel.close(); }
});
