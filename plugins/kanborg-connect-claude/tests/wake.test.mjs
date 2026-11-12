// Tests for the KanBorg wake channel (wake/server.mjs).
// Run: node --test plugins/kanborg-connect-claude/tests/wake.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WakeChannel, KanborgClient, validSignal, ADAPTER_ID } from '../wake/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, '..', 'wake', 'server.mjs');
const fake = join(here, 'fixtures', 'fake-kanborg-mcp.mjs');
// Short root: Unix socket paths are limited to ~104 bytes on macOS.
const tmp = () => mkdtempSync(join(tmpdir(), 'kbw-'));
const signal = (o = {}) => ({ id: randomUUID(), workspaceId: 'ws-1', clientId: 'client-1', epoch: 3, kind: 'coordinator-request', cursor: 41, ...o });

function ask(socket, msg) {
  return new Promise((res, rej) => {
    const s = connect(socket); let buf = '';
    s.on('connect', () => s.write(JSON.stringify(msg) + '\n'));
    s.on('data', (c) => { buf += c; }); s.on('end', () => res(JSON.parse(buf))); s.on('error', rej);
  });
}

test('validSignal rejects malformed signals', () => {
  assert.ok(validSignal(signal()));
  assert.ok(!validSignal(signal({ id: 'nope' })));
  assert.ok(!validSignal(signal({ epoch: -1 })));
  assert.ok(!validSignal(signal({ kind: 'bad kind with spaces' })));
});

test('push wake: one notification per event, durable receipt, reconcile', async () => {
  const out = []; const root = tmp();
  const ch = new WakeChannel({ root, chatId: randomUUID(), out: (m) => out.push(m), client: null });
  await ch.openInbox();
  try {
    const reg = JSON.parse(readFileSync(ch.registryPath, 'utf8'));
    assert.equal(reg.adapterId, ADAPTER_ID);
    assert.equal(statSync(ch.registryPath).mode & 0o777, 0o600);
    assert.equal(statSync(reg.socket).mode & 0o777, 0o600);
    const base = { v: 1, token: reg.token, chatId: reg.chatId };
    assert.equal((await ask(reg.socket, { ...base, type: 'ping' })).state, 'available');
    const s = signal();
    const r1 = await ask(reg.socket, { ...base, type: 'wake', signal: s });
    assert.equal(r1.state, 'accepted');
    assert.match(r1.receipt, new RegExp(`^claude-channel:${reg.chatId}:${s.id}$`));
    const r2 = await ask(reg.socket, { ...base, type: 'wake', signal: s });
    assert.equal(r2.receipt, r1.receipt); assert.equal(r2.duplicate, true);
    const notes = out.filter((m) => m.method === 'notifications/claude/channel');
    assert.equal(notes.length, 1, 'duplicate delivery must not re-notify');
    assert.equal(notes[0].params.meta.event_id, s.id);
    assert.ok(Object.keys(notes[0].params.meta).every((k) => /^[A-Za-z0-9_]+$/.test(k)));
    assert.match(notes[0].params.content, /not new authority/);
    assert.equal((await ask(reg.socket, { ...base, type: 'reconcile', eventId: s.id })).receipt, r1.receipt);
    assert.equal((await ask(reg.socket, { ...base, type: 'reconcile', eventId: randomUUID() })).state, 'unknown');
  } finally { ch.close(); }
  assert.ok(!existsSync(ch.registryPath), 'registry removed on close');
});

test('push wake: wrong token, wrong chat and invalid signal are not delivered', async () => {
  const out = []; const ch = new WakeChannel({ root: tmp(), chatId: randomUUID(), out: (m) => out.push(m), client: null });
  await ch.openInbox();
  try {
    const reg = JSON.parse(readFileSync(ch.registryPath, 'utf8'));
    assert.equal((await ask(reg.socket, { v: 1, token: 'x'.repeat(64), chatId: reg.chatId, type: 'wake', signal: signal() })).error, 'unauthorized');
    assert.equal((await ask(reg.socket, { v: 1, token: reg.token, chatId: randomUUID(), type: 'wake', signal: signal() })).error, 'wrong chat');
    assert.equal((await ask(reg.socket, { v: 1, token: reg.token, chatId: reg.chatId, type: 'wake', signal: signal({ id: '1' }) })).state, 'not-delivered');
    assert.equal(out.length, 0);
  } finally { ch.close(); }
});

test('watch mode: wakes on new events through the KanBorg launcher, skips history and noise', async () => {
  const dir = tmp(); const stateFile = join(dir, 'kb.json'); const client = randomUUID();
  const put = (s) => writeFileSync(stateFile, JSON.stringify({ client, workspaces: [{ workspaceId: 'ws-1', name: 'Alpha' }], ...s }));
  put({ events: [{ cursor: 1, type: 'coordinator-request' }], pending: ['r1'] });
  process.env.FAKE_KANBORG_STATE = stateFile;
  const out = [];
  const ch = new WakeChannel({ root: dir, chatId: randomUUID(), out: (m) => out.push(m), client: new KanborgClient(fake, client), minGapMs: 0 });
  try {
    await ch.setWatch('ws-1', true);
    await ch.pollOnce();
    assert.equal(out.length, 0, 'existing history does not wake');
    put({ events: [{ cursor: 1, type: 'coordinator-request' }, { cursor: 2, type: 'chat-message-sent' }], pending: ['r1'] });
    await ch.pollOnce();
    assert.equal(out.length, 0, 'quiet events do not wake');
    put({ events: [{ cursor: 1, type: 'x' }, { cursor: 2, type: 'chat-message-sent' }, { cursor: 3, type: 'blocked' }], pending: ['r1', 'r2'] });
    await ch.pollOnce();
    assert.equal(out.length, 1);
    assert.equal(out[0].params.meta.mode, 'watch');
    assert.equal(out[0].params.meta.from_cursor, '2');
    assert.match(out[0].params.content, /project "Alpha"/);
    await ch.pollOnce();
    assert.equal(out.length, 1, 'no repeat wake for the same events');
    assert.equal(ch.status().watch.workspaces[0].cursor, 3);
  } finally { ch.close(); }
});

test('watch mode: unknown workspace and missing connection are explicit errors', async () => {
  const dir = tmp(); const stateFile = join(dir, 'kb.json'); const client = randomUUID();
  writeFileSync(stateFile, JSON.stringify({ client, workspaces: [], events: [] }));
  process.env.FAKE_KANBORG_STATE = stateFile;
  const ch = new WakeChannel({ root: dir, chatId: randomUUID(), out: () => {}, client: new KanborgClient(fake, client) });
  await assert.rejects(ch.setWatch('ws-9', true), /cannot see that workspace/);
  ch.close();
  const none = new WakeChannel({ root: dir, chatId: randomUUID(), out: () => {}, client: null, connectionId: '' });
  await assert.rejects(none.setWatch('ws-1', true), /connection ID/);
});

test('stdio MCP: declares the claude/channel capability and tools', async () => {
  const root = tmp();
  const p = spawn(process.execPath, [server], { env: { ...process.env, KANBORG_WAKE_HOME: root, KANBORG_CONNECTION_ID: '${user_config.kanborg_connection_id}' } });
  const lines = []; let buf = '';
  p.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  const waitFor = async (id) => { for (let i = 0; i < 100; i++) { const m = lines.find((l) => l.id === id); if (m) return m; await new Promise((r) => setTimeout(r, 20)); } throw Error('timeout ' + id); };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  const init = await waitFor(1);
  assert.deepEqual(init.result.capabilities.experimental, { 'claude/channel': {} });
  assert.match(init.result.instructions, /grant no authority/);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual((await waitFor(2)).result.tools.map((t) => t.name), ['kanborgWakeStatus', 'kanborgWakeWatch']);
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kanborgWakeStatus', arguments: {} } });
  const st = (await waitFor(3)).result.structuredContent;
  assert.equal(st.adapterId, ADAPTER_ID);
  assert.equal(st.watch.connectionConfigured, false, 'unsubstituted placeholder counts as unset');
  p.stdin.end();
  await new Promise((r) => p.on('exit', r));
});
