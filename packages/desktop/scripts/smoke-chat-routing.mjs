// Run with ELECTRON_RUN_AS_NODE=1 using the packaged Electron runtime. Uses an in-memory database only.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {openStoreInMemory} from '../../local-store/dist/index.js';
import {createSupervisor} from '../../api/dist/index.js';
const store=openStoreInMemory();const conversation=store.chatConversations.create({title:'Routing test'});const session=store.chatSessions.create({conversationId:conversation.id,agentProvider:'claude-code'});const emitter=new EventEmitter();const handle={pid:null,done:new Promise(()=>{}),on:(...a)=>{emitter.on(...a);return handle},off:(...a)=>{emitter.off(...a);return handle},stop:()=>{}};
const supervisor=await createSupervisor({store,repoPath:'/private/tmp',startAgentRun:()=>handle});
const run=await supervisor.startChat({threadId:conversation.threadId,chatSessionId:session.id,prompt:'test',provider:'claude-code'});
emitter.emit('event',{kind:'session',sessionId:'kanbots-auto-test',provider:'codex-cli',model:'test-openai-model'});
emitter.emit('event',{kind:'text',text:'OpenAI answer'});
assert.equal(store.chatSessions.findById(session.id).agentProvider,'codex-cli');assert.equal(store.agentRuns.findById(run.id).provider,'codex-cli');assert.equal(store.events.list(run.id).find(e=>e.payload.text==='OpenAI answer').payload.provider,'codex-cli');
emitter.emit('event',{kind:'session',sessionId:'kanbots-auto-test',provider:'claude-code',model:'test-claude-model'});emitter.emit('event',{kind:'text',text:'Claude answer'});
assert.equal(store.chatSessions.findById(session.id).agentProvider,'claude-code');assert.equal(store.events.list(run.id).find(e=>e.payload.text==='OpenAI answer').payload.provider,'codex-cli');assert.equal(store.events.list(run.id).find(e=>e.payload.text==='Claude answer').payload.provider,'claude-code');
store.close();console.log('PASS: routed chat updates run/session provider and preserves per-message provenance');process.exit(0);
