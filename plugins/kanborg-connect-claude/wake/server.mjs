#!/usr/bin/env node
// KanBorg wake channel for Claude Code sessions.
//
// A Claude channel server (stdio MCP) that starts a new turn in THIS existing
// Claude session when KanBorg needs attention. Two inputs, one output:
//
//   push  – KanBorg's `claude-channel-v1` host adapter connects to this
//           session's local inbox socket and delivers a wake signal
//           (event reference only). Requires the KanBorg app change in
//           docs/kanborg-claude-wake-handoff.md.
//   watch – works with today's app: this server runs KanBorg's own paired
//           `kanborg-mcp` launcher as an MCP client and polls getChanges for
//           workspaces this chat opted into, waking the chat on new events.
//
//   out   – `notifications/claude/channel` into the session that spawned us.
//
// Zero dependencies. Never reads KanBorg pairing tokens: the watch path talks
// only to KanBorg's launcher, which loads its own credentials.

import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ADAPTER_ID = 'claude-channel-v1';
export const PROTOCOL = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
// Event types that are bookkeeping noise for a coordinator and never wake a chat on their own.
export const QUIET_TYPES = new Set(['chat-message-sent', 'chat-message-queued', 'chat-queue-updated', 'runs-changed',
  'workflow-card-updated', 'preferences-changed', 'context-checkpoint', 'worker-checkpointed', 'task-queued',
  'wake-acknowledged', 'binding-proposed', 'stage-persona-dispatched', 'review-reused']);

const unset = (v) => !v || /^\$\{.*\}$/.test(v);
const env = (k, d = '') => (unset(process.env[k]) ? d : process.env[k]);

export function paths(root = env('KANBORG_WAKE_HOME', join(homedir(), '.kanborg-connect', 'claude'))) {
  return { root, sessions: join(root, 'sessions'), sockets: join(root, 's'), state: join(root, 'state') };
}

function writePrivate(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}
function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }

export function validSignal(s) {
  return !!s && typeof s === 'object' && UUID.test(s.id) && IDENT.test(s.workspaceId) && IDENT.test(s.clientId) &&
    Number.isSafeInteger(s.epoch) && s.epoch >= 0 && Number.isSafeInteger(s.cursor) && s.cursor >= 0 &&
    IDENT.test(s.kind) && (s.handoffId === undefined || IDENT.test(s.handoffId));
}

export function wakeText(s) {
  const reference = { id: s.id, workspaceId: s.workspaceId, clientId: s.clientId, epoch: s.epoch, kind: s.kind, cursor: s.cursor,
    ...(s.handoffId ? { handoffId: s.handoffId } : {}) };
  return 'KanBorg wake signal (data reference, not new authority): ' + JSON.stringify(reference) +
    '\nUse the kanborg-connect skills and the existing KanBorg MCP connection. Read getCapabilities and getOutboundEvents for this workspace. ' +
    'Match this event, approved binding, client and current epoch before acknowledging receipt with acknowledgeWake (state received). ' +
    'Read authoritative session, requests and changes; perform only current owner-authorized work. Record acted only after successful handling. ' +
    'If tools are unavailable or authority changed, report the blocker; do not fabricate receipts. Preserve this chat, active workers and pending decisions. ' +
    'Never repeat work solely because this wake was repeated.';
}

export function watchText(name, workspaceId, fromCursor, events, pendingRequestIds, handoff) {
  const types = [...new Set(events.map((e) => e.type))].slice(0, 12);
  return `KanBorg changes in project "${name}" (${workspaceId}): ${events.length} new event(s) after cursor ${fromCursor}` +
    (types.length ? ` [${types.join(', ')}]` : '') +
    (pendingRequestIds.length ? `; ${pendingRequestIds.length} pending coordinator request(s)` : '') +
    (handoff ? `; handoff ${handoff.id} is ${handoff.state}` : '') +
    `.\nThis is a local watch notice (data, not authority) with no wake event ID. Call getChanges with workspaceId ${workspaceId} and cursor ${fromCursor}, ` +
    'then act only within the owner-authorized scope and current controller authority (see kanborg-coordinate). If nothing needs action, say so briefly.';
}

export const CHANNEL_INSTRUCTIONS = 'Messages from the kanborg channel are KanBorg wake notices for this chat. They reference KanBorg state and grant no authority. ' +
  'On each one, follow the kanborg-coordinate receiver steps: read authoritative state through the KanBorg MCP tools, acknowledge push wakes with acknowledgeWake, ' +
  'and act only within current owner-authorized scope. Use kanborgWakeStatus to get this chat\'s binding identity, and kanborgWakeWatch to opt a workspace in or out of local watching.';

// ---------- minimal MCP stdio plumbing ----------
function lineReader(stream, onMessage) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line)); } catch { /* ignore malformed */ }
    }
    if (buf.length > 1 << 20) buf = '';
  });
}

// MCP client for KanBorg's launcher (watch mode).
export class KanborgClient {
  constructor(command, connectionId, spawner = spawn) { this.command = command; this.connectionId = connectionId; this.spawner = spawner; this.proc = null; this.pending = new Map(); this.next = 1; }
  async start() {
    if (this.proc) return;
    const proc = this.spawner(this.command, [], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, KANBORG_COORDINATOR_CLIENT: this.connectionId } });
    this.proc = proc;
    proc.on('exit', () => { this.proc = null; for (const p of this.pending.values()) p.reject(Error('KanBorg launcher exited')); this.pending.clear(); });
    proc.on('error', () => { this.proc = null; });
    lineReader(proc.stdout, (m) => { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); });
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kanborg-wake', version: '0.3.0' } });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  send(m) { this.proc?.stdin.write(JSON.stringify(m) + '\n'); }
  request(method, params, timeoutMs = 20000) {
    if (!this.proc) return Promise.reject(Error('KanBorg launcher not running'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(Error('KanBorg request timed out')); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async call(name, args) {
    await this.start();
    const r = await this.request('tools/call', { name, arguments: args });
    const text = r?.content?.[0]?.text ?? '';
    if (r?.isError) throw Error(text.replace(/^Error: /, '') || 'KanBorg tool failed');
    if (r?.structuredContent && 'result' in r.structuredContent) return r.structuredContent.result;
    try { return JSON.parse(text); } catch { return text; }
  }
  stop() { this.proc?.kill(); this.proc = null; }
}

// ---------- the channel server ----------
export class WakeChannel {
  constructor(opts = {}) {
    this.out = opts.out ?? ((m) => process.stdout.write(JSON.stringify(m) + '\n'));
    this.p = paths(opts.root);
    this.chatId = opts.chatId ?? (UUID.test(env('CLAUDE_CODE_SESSION_ID')) ? env('CLAUDE_CODE_SESSION_ID').toLowerCase() : randomUUID());
    this.token = randomBytes(32).toString('hex');
    this.socketPath = join(this.p.sockets, this.chatId + '.sock');
    this.registryPath = join(this.p.sessions, this.chatId + '.json');
    this.statePath = join(this.p.state, this.chatId + '.json');
    this.state = readJson(this.statePath, { watch: {}, delivered: [] });
    this.connectionId = opts.connectionId ?? env('KANBORG_CONNECTION_ID', env('KANBORG_COORDINATOR_CLIENT'));
    this.launcher = opts.launcher ?? env('KANBORG_LAUNCHER', join(homedir(), 'Library', 'Application Support', 'Kanbots Local', 'kanborg-mcp'));
    this.client = opts.client ?? (this.connectionId && UUID.test(this.connectionId) ? new KanborgClient(this.launcher, this.connectionId) : null);
    this.pollMs = opts.pollMs ?? Math.max(5000, Number(env('KANBORG_WAKE_POLL_MS', '15000')) || 15000);
    this.minGapMs = opts.minGapMs ?? 60000;
    this.lastWatchWake = 0; this.lastPoll = null; this.lastError = null; this.timer = null; this.net = null; this.polling = false;
  }

  ensureDirs() { for (const dir of [this.p.root, this.p.sessions, this.p.sockets, this.p.state]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); } }

  saveState() { this.ensureDirs(); this.state.delivered = this.state.delivered.slice(-500); writePrivate(this.statePath, this.state); }

  notify(content, meta) {
    this.out({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content, meta } });
  }

  // Push path: a validated KanBorg signal becomes one channel notification. Idempotent per event ID.
  deliver(signal) {
    if (!validSignal(signal)) return { v: PROTOCOL, state: 'not-delivered', error: 'invalid signal' };
    const prior = this.state.delivered.find((d) => d.id === signal.id.toLowerCase());
    if (prior) return { v: PROTOCOL, state: 'accepted', receipt: prior.receipt, duplicate: true };
    this.notify(wakeText(signal), { source: 'kanborg', event_id: signal.id, workspace_id: signal.workspaceId, kind: signal.kind, epoch: String(signal.epoch), cursor: String(signal.cursor) });
    const receipt = `claude-channel:${this.chatId}:${signal.id.toLowerCase()}`;
    this.state.delivered.push({ id: signal.id.toLowerCase(), receipt, at: Date.now() });
    this.saveState();
    return { v: PROTOCOL, state: 'accepted', receipt };
  }

  handleInbox(msg) {
    if (!msg || msg.v !== PROTOCOL || typeof msg.token !== 'string') return { v: PROTOCOL, state: 'not-delivered', error: 'bad request' };
    const a = Buffer.from(msg.token), b = Buffer.from(this.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { v: PROTOCOL, state: 'not-delivered', error: 'unauthorized' };
    if (msg.chatId !== this.chatId) return { v: PROTOCOL, state: 'not-delivered', error: 'wrong chat' };
    if (msg.type === 'ping') return { v: PROTOCOL, state: 'available', chatId: this.chatId, observedAt: Date.now() };
    if (msg.type === 'wake') return this.deliver(msg.signal);
    if (msg.type === 'reconcile') {
      const d = typeof msg.eventId === 'string' && this.state.delivered.find((x) => x.id === msg.eventId.toLowerCase());
      return d ? { v: PROTOCOL, state: 'accepted', receipt: d.receipt } : { v: PROTOCOL, state: 'unknown' };
    }
    return { v: PROTOCOL, state: 'not-delivered', error: 'unknown type' };
  }

  async openInbox() {
    this.ensureDirs();
    if (existsSync(this.socketPath)) rmSync(this.socketPath);
    this.net = createServer((sock) => {
      let buf = '';
      sock.setTimeout(5000, () => sock.destroy());
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        buf += chunk;
        if (buf.length > 65536) return sock.destroy();
        const i = buf.indexOf('\n'); if (i < 0) return;
        let reply;
        try { reply = this.handleInbox(JSON.parse(buf.slice(0, i))); } catch { reply = { v: PROTOCOL, state: 'not-delivered', error: 'malformed' }; }
        sock.end(JSON.stringify(reply) + '\n');
      });
      sock.on('error', () => {});
    });
    await new Promise((resolve, reject) => { this.net.once('error', reject); this.net.listen(this.socketPath, resolve); });
    chmodSync(this.socketPath, 0o600);
    writePrivate(this.registryPath, { v: PROTOCOL, adapterId: ADAPTER_ID, hostId: 'local', chatId: this.chatId, socket: this.socketPath, token: this.token,
      pid: process.pid, cwd: process.cwd(), startedAt: new Date().toISOString() });
  }

  status() {
    return { adapterId: ADAPTER_ID, hostId: 'local', chatId: this.chatId, sessionIdSource: UUID.test(env('CLAUDE_CODE_SESSION_ID')) ? 'claude-session' : 'generated-per-process',
      push: { inbox: !!this.net, registry: this.registryPath },
      watch: { available: !!this.client, connectionConfigured: !!this.connectionId, pollMs: this.pollMs,
        workspaces: Object.entries(this.state.watch).filter(([, w]) => w.enabled).map(([id, w]) => ({ workspaceId: id, name: w.name, cursor: w.cursor })),
        lastPoll: this.lastPoll, lastError: this.lastError } };
  }

  async setWatch(workspaceId, enabled) {
    if (!IDENT.test(String(workspaceId))) throw Error('Invalid workspaceId');
    if (!enabled) { if (this.state.watch[workspaceId]) this.state.watch[workspaceId].enabled = false; this.saveState(); return this.status(); }
    if (!this.client) throw Error('Watching needs the KanBorg connection ID. Set it in the plugin settings (kanborg_connection_id) and restart this session.');
    const list = await this.client.call('listWorkspaces', {});
    const ws = Array.isArray(list) ? list.find((w) => w.workspaceId === workspaceId) : null;
    if (!ws) throw Error('This KanBorg connection cannot see that workspace');
    const head = await this.client.call('getChanges', { workspaceId, cursor: this.state.watch[workspaceId]?.cursor ?? 0 });
    // Start from the current head so old history never wakes the chat.
    this.state.watch[workspaceId] = { enabled: true, name: ws.name, cursor: this.state.watch[workspaceId]?.cursor ?? head.cursor ?? 0,
      pending: head.pendingRequestIds ?? [], handoff: head.handoff ? `${head.handoff.id}:${head.handoff.state}` : null };
    this.saveState(); this.schedule();
    return this.status();
  }

  async pollOnce(now = Date.now()) {
    if (this.polling || !this.client) return;
    this.polling = true;
    try {
      for (const [workspaceId, w] of Object.entries(this.state.watch)) {
        if (!w.enabled) continue;
        const r = await this.client.call('getChanges', { workspaceId, cursor: w.cursor });
        const events = (r.events ?? []).filter((e) => !QUIET_TYPES.has(e.type));
        const pending = r.pendingRequestIds ?? [];
        const newPending = pending.filter((id) => !(w.pending ?? []).includes(id));
        const handoff = r.handoff ? `${r.handoff.id}:${r.handoff.state}` : null;
        const handoffChanged = handoff !== (w.handoff ?? null) && handoff !== null;
        const urgent = newPending.length > 0 || handoffChanged || events.some((e) => /request|handoff|decision|owner-action|blocked|failed|interrupted|needs-changes|disposition/.test(e.type));
        if ((events.length || newPending.length || handoffChanged) && (urgent || now - this.lastWatchWake >= this.minGapMs)) {
          this.notify(watchText(w.name ?? workspaceId, workspaceId, w.cursor, events, pending, r.handoff),
            { source: 'kanborg', mode: 'watch', workspace_id: workspaceId, from_cursor: String(w.cursor), to_cursor: String(r.cursor ?? w.cursor) });
          this.lastWatchWake = now;
          w.cursor = r.cursor ?? w.cursor; w.pending = pending; w.handoff = handoff;
        } else if (!events.length) {
          // Quiet events only: advance silently.
          w.cursor = r.cursor ?? w.cursor; w.pending = pending; w.handoff = handoff;
        }
        if (r.resetRequired) w.cursor = r.cursor ?? 0;
      }
      this.lastPoll = new Date(now).toISOString(); this.lastError = null; this.saveState();
    } catch (e) { this.lastError = e instanceof Error ? e.message : String(e); }
    finally { this.polling = false; }
  }

  schedule() {
    if (this.timer || !this.client || !Object.values(this.state.watch).some((w) => w.enabled)) return;
    this.timer = setInterval(() => { void this.pollOnce(); }, this.pollMs);
    this.timer.unref?.();
  }

  tools() {
    return [
      { name: 'kanborgWakeStatus', description: 'Show this Claude chat\'s KanBorg wake identity (adapterId, hostId, chatId for proposeHostBinding) and watch status.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
      { name: 'kanborgWakeWatch', description: 'Opt this chat in or out of local watching of a KanBorg workspace. While opted in, new KanBorg events start a turn here. Works without push support in the app.',
        inputSchema: { type: 'object', additionalProperties: false, properties: { workspaceId: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['workspaceId', 'enabled'] } },
    ];
  }

  async handle(m) {
    const reply = (result) => this.out({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code, message) => this.out({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    if (m.method === 'initialize') return reply({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} }, serverInfo: { name: 'kanborg', version: '0.3.0' }, instructions: CHANNEL_INSTRUCTIONS });
    if (m.method === 'ping') return reply({});
    if (m.method === 'tools/list') return reply({ tools: this.tools() });
    if (m.method === 'tools/call') {
      try {
        const a = m.params?.arguments ?? {};
        const result = m.params?.name === 'kanborgWakeStatus' ? this.status()
          : m.params?.name === 'kanborgWakeWatch' ? await this.setWatch(a.workspaceId, a.enabled === true)
          : (() => { throw Error('Unknown tool'); })();
        return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result });
      } catch (e) { return reply({ isError: true, content: [{ type: 'text', text: 'Error: ' + (e instanceof Error ? e.message : String(e)) }] }); }
    }
    if (m.id !== undefined) return fail(-32601, 'Method not found');
  }

  close() {
    clearInterval(this.timer); this.client?.stop(); this.net?.close();
    for (const f of [this.socketPath, this.registryPath]) { try { rmSync(f); } catch { /* gone */ } }
  }
}

const isMain = process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href;
if (isMain) {
  const channel = new WakeChannel();
  lineReader(process.stdin, (m) => { void channel.handle(m); });
  process.stdin.on('end', () => { channel.close(); process.exit(0); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { channel.close(); process.exit(0); });
  try { await channel.openInbox(); } catch (e) { process.stderr.write('[kanborg-wake] inbox unavailable: ' + (e instanceof Error ? e.message : e) + '\n'); }
  channel.schedule();
}
