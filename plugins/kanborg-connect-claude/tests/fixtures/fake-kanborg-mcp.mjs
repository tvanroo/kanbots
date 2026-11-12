#!/usr/bin/env node
// Stand-in for KanBorg's kanborg-mcp launcher. Serves listWorkspaces/getChanges
// from the JSON file named by FAKE_KANBORG_STATE (re-read on every call).
import { readFileSync } from 'node:fs';
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.id === undefined) continue;
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
    if (m.method === 'initialize') { send({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'kanborg', version: 'fake' } }); continue; }
    const state = JSON.parse(readFileSync(process.env.FAKE_KANBORG_STATE, 'utf8'));
    if (process.env.KANBORG_COORDINATOR_CLIENT !== state.client) { send({ isError: true, content: [{ type: 'text', text: 'Error: Pair in KanBorg Coordinators' }] }); continue; }
    const { name, arguments: a } = m.params;
    let result;
    if (name === 'listWorkspaces') result = state.workspaces;
    else if (name === 'getChanges') {
      const events = state.events.filter((e) => e.cursor > (a.cursor ?? 0));
      result = { events, cursor: events.at(-1)?.cursor ?? a.cursor ?? 0, pendingRequestIds: state.pending ?? [], handoff: state.handoff ?? null, resetRequired: false };
    } else { send({ isError: true, content: [{ type: 'text', text: 'Error: unknown' }] }); continue; }
    send({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { result } });
  }
});
