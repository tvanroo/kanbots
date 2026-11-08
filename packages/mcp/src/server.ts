#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { COORDINATOR_TOOLS, COORDINATOR_GUIDE, KANBOTS_TOOLS } from './index.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Local-only launch by default. Cloud sign-in is OPTIONAL: we read the
// session status once at startup so we can annotate tool errors with a
// helpful hint, but missing/expired cloud credentials never block the
// server from starting. Cloud-dependent tools surface their own errors
// when invoked without a session (the desktop tool-bridge enforces the
// real auth boundary; this layer only proxies).
const coordinated=process.env.KANBOTS_COORDINATOR==='1'||!!(process.env.KANBORG_COORDINATOR_CLIENT??process.env.KANBOTS_COORDINATOR_CLIENT);
const dataDir=process.env.KANBORG_LOCAL_DATA??process.env.KANBOTS_LOCAL_DATA??join(homedir(),'Library','Application Support','Kanbots Local');

const BRIDGE_URL = process.env.KANBOTS_TOOL_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.KANBOTS_TOOL_BRIDGE_TOKEN;

if (!coordinated && (!BRIDGE_URL || !BRIDGE_TOKEN)) {
  process.stderr.write(
    '[kanbots-mcp] KANBOTS_TOOL_BRIDGE_URL and KANBOTS_TOOL_BRIDGE_TOKEN env vars are required\n',
  );
  process.exit(1);
}

async function callBridge(name: string, args: unknown): Promise<unknown> {
  let url=BRIDGE_URL,token=BRIDGE_TOKEN;
  const id=process.env.KANBORG_COORDINATOR_CLIENT??process.env.KANBOTS_COORDINATOR_CLIENT;
  if(id){
    if(!/^[0-9a-f-]{36}$/.test(id))throw Error('Invalid paired client');
    const endpoint=JSON.parse(await readFile(join(dataDir,'coordinator-endpoint.json'),'utf8'));
    const profile=JSON.parse(await readFile(join(dataDir,'coordinator-clients',id+'.json'),'utf8'));
    url=endpoint.url; token=profile.token;
    if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(url!))throw Error('Invalid local endpoint');
    const session=await fetch(`${url}/session`,{method:'POST',headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(5000)});
    const reply=await session.json() as {token?:string;error?:string};
    if(!session.ok||!reply.token)throw Error(reply.error??'Pair in KanBorg Coordinators');
    token=reply.token;
  }
  if(!url||!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)||!token)throw Error('Open KanBorg and check coordinator pairing.');
  const response = await fetch(`${url}/tool/${encodeURIComponent(name)}`, {
    method: 'POST',
    redirect:'error',
    signal:AbortSignal.timeout(30000),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args ?? {}),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // not JSON
    }
    throw new Error(message || `tool bridge returned ${response.status}`);
  }
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const server = new Server(
  { name: 'kanborg', version: '1.2.30' },
  { capabilities: { tools: {} }, ...(coordinated?{instructions:COORDINATOR_GUIDE}:{}) },
);

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({ tools: (coordinated?COORDINATOR_TOOLS:KANBOTS_TOOLS) as unknown as never[] }),
);

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await callBridge(name, args);
    return {
      ...(coordinated?{structuredContent:{result}}:{}),
      content: [
        {
          type: 'text' as const,
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const text = `Error: ${message}`;
    return {
      isError: true,
      content: [{ type: 'text' as const, text }],
    };
  }
});

if(coordinated) await callBridge('getCapabilities',{}).catch(error=>process.stderr.write(`[kanbots-local] ${error instanceof Error?error.message:'Pair in KanBorg Coordinators'}\n`));
const transport = new StdioServerTransport();
server
  .connect(transport)
  .catch((err: unknown) => {
    process.stderr.write(
      `[kanbots-mcp] failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
