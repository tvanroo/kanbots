import { app } from 'electron';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync,readFileSync,writeFileSync,mkdirSync,renameSync } from 'node:fs';
import { join } from 'node:path';
import { startAgentRun,type StartAgentRunOptions,type AgentRunHandle,type RunSummary,type StreamEvent } from '@kanborg/dispatcher';
import { apiTurn,RouteUnavailable,type TranscriptEntry } from './api-task.js';
import { collectCapacity,invalidateCapacity,type Candidate } from './routing-capacity.js';
import { readRouting,recordDecision } from './routing-state.js';
type Session={cwd:string;transcript:TranscriptEntry[];native?:{provider:'claude-code'|'codex-cli';id:string}};
const sessions=()=>join(app.getPath('userData'),'routed-sessions');
function saveSession(id:string,data:Session){mkdirSync(sessions(),{recursive:true,mode:0o700});const path=join(sessions(),id+'.json');writeFileSync(path+'.tmp',JSON.stringify(data),{mode:0o600});renameSync(path+'.tmp',path);}
export function startRoutedRun(opts:StartAgentRunOptions):AgentRunHandle{
  const isResume=opts.resumeFromSessionId?.startsWith('kanbots-auto-');
  if((!readRouting().config.enabled&&!isResume)||(!isResume&&opts.resumeFromSessionId)|| (opts.provider&&!['claude-code','codex-cli'].includes(opts.provider)))return startAgentRun(opts);
  const emitter=new EventEmitter();const abort=new AbortController();let child:AgentRunHandle|undefined;
  const id=isResume?opts.resumeFromSessionId!:'kanbots-auto-'+randomUUID();
  let session:Session={cwd:opts.cwd,transcript:[]};
  let settle!:(summary:RunSummary)=>void;
  const done=new Promise<RunSummary>(resolve=>{settle=resolve;});
  const handle:AgentRunHandle={pid:null,on(event,fn){emitter.on(event,fn);return this;},off(event,fn){emitter.off(event,fn);return this;},stop(){abort.abort();child?.stop();},done};
  const emit=(event:StreamEvent)=>emitter.emit('event',event);
  setImmediate(()=>void (async()=>{
    const started=Date.now();let cost=0;let input=0;let output=0;let failure:string|undefined;
    try{
      if(isResume){
        if(!/^kanbots-auto-[0-9a-f-]{36}$/.test(id))throw Error('Invalid routed session');
        session=JSON.parse(readFileSync(join(sessions(),id+'.json'),'utf8')) as Session;
        if(session.cwd!==opts.cwd)throw Error('Session workspace changed; start a new task.');
      }
      session.transcript.push({role:'user',text:opts.prompt});saveSession(id,session);
      const blocked=new Set<string>();let lastRoute='';
      const maxUsd=Math.min(readRouting().config.maxRunUsd,opts.costBudgetUsd??Infinity);
      for(let step=0;step<80;step++){
        abort.signal.throwIfAborted();
        const {candidates}=await collectCapacity(true,step===0);
        const route=candidates.find(c=>!blocked.has(c.id));
        if(!route)throw Error('No usable capacity: refresh quota or grant balances, connect a priced API model, or enable an allowed payment source.');
        if(route.id!==lastRoute){
          lastRoute=route.id;
          const message=`Routing: ${route.kind==='subscription'?(route.provider==='claude-code'?'Claude subscription':'ChatGPT subscription'):`${route.row!.name} · ${route.funding==='grant'?'API grant':'pay-as-you-go'} · ${route.model!.id}`} — ${route.reason}.`;
          recordDecision(message);emit({kind:'text',text:message+'\n'});
          emit({kind:'session',sessionId:id,model:route.model?.id??null,provider:route.provider});
        }
        if(route.kind==='api'){
          delete session.native;
          try{
            const result=await apiTurn(route,opts,session.transcript,abort.signal,emit,maxUsd-cost);
            cost+=result.usd;input+=result.input;output+=result.output;
            emit({kind:'result',isError:false,text:'',tokenUsage:{input:result.input,output:result.output},durationMs:null,totalCostUsd:result.usd});
            saveSession(id,session);
            if(result.done)return;
          }catch(error){
            if(error instanceof RouteUnavailable){blocked.add(route.id);emit({kind:'text',text:'Switching payment source before the next request: '+error.message+'\n'});continue;}
            throw error;
          }
        }else{
          const same=session.native?.provider===route.provider;
          const prompt=same?opts.prompt:session.transcript.map(m=>`${m.role}: ${m.text}`).join('\n\n');
          // Never inherit API credentials or alternate endpoints into subscription workers.
          const cleanSpawn:NonNullable<StartAgentRunOptions['spawn']>=(command,args,options)=>{
            const env={...process.env,...options?.env};
            for(const name of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','OPENAI_API_KEY','OPENAI_BASE_URL','CODEX_API_KEY'])delete env[name];
            return spawn(command,args,{...options,env});
          };
          // MCP CLI arguments are provider-specific. API bridge remains available via original provider wiring only.
          let extraArgs=route.provider===opts.provider?opts.extraArgs:undefined;
          const mcpEntry=opts.env?.KANBOTS_MCP_ENTRY;
          if(mcpEntry){
            if(route.provider==='codex-cli')extraArgs=['-c',`mcp_servers.kanbots.command=${JSON.stringify(process.execPath)}`,'-c',`mcp_servers.kanbots.args=[${JSON.stringify(mcpEntry)}]`,'-c','mcp_servers.kanbots.env_vars=["KANBOTS_COORDINATOR","KANBOTS_TOOL_BRIDGE_URL", "KANBOTS_TOOL_BRIDGE_TOKEN", "ELECTRON_RUN_AS_NODE"]'];
            else{
              const config=join(sessions(),id+'-mcp.json');
              writeFileSync(config,JSON.stringify({mcpServers:{kanbots:{command:process.execPath,args:[mcpEntry]}}}),{mode:0o600});
              extraArgs=['--mcp-config',config];
            }
          }
          child=startAgentRun({cwd:opts.cwd,prompt,provider:route.provider,spawn:cleanSpawn,
            ...(opts.appendSystemPrompt?{appendSystemPrompt:opts.appendSystemPrompt}:{}),
            ...(same&&session.native?{resumeFromSessionId:session.native.id}:{}),
            ...(opts.env?{env:opts.env}:{}),...(extraArgs?{extraArgs}:{}),
          });
          let limited=false;let hadTools=false;
          child.on('event',event=>{
            if(event.kind==='session'){
              session.native={provider:route.provider,id:event.sessionId};saveSession(id,session);
              emit({...event,sessionId:id,provider:route.provider});return;
            }
            if(event.kind==='rate_limit'){limited=true;return;}
            if(event.kind==='tool_use')hadTools=true;
            if(event.kind==='text')session.transcript.push({role:'assistant',text:event.text});
            if(event.kind==='tool_result')session.transcript.push({role:'user',text:`Completed tool ${event.toolUseId}: ${JSON.stringify(event.content)}`});
            // Subscription CLI dollar values are price equivalents, not API charges.
            emit(event.kind==='result'?{...event,totalCostUsd:null}:event);
          });
          child.on('error',()=>{});
          // Re-evaluate before a subscription can quietly become a paid-credit route.
          const monitor=setInterval(()=>void collectCapacity(false,true).then(({candidates})=>{
            if(!candidates.some(c=>c.id===route.id)){limited=true;child?.stop();}
          }).catch(()=>{}),60000);
          const summary=await child.done;clearInterval(monitor);child=undefined;saveSession(id,session);
          if(limited){blocked.add(route.id);invalidateCapacity();delete session.native;
            if(hadTools)session.transcript.push({role:'user',text:'The previous subscription stopped for capacity. Continue from recorded completed tool results; inspect current files before making further changes.'});
            continue;
          }
          if(summary.result?.isError||summary.exitCode!==0)throw Error('Subscription task did not complete. Review its output and resume when ready.');
          return;
        }
      }
      throw Error('Task reached the 80-step limit; resume to continue.');
    }catch(error){failure=abort.signal.aborted?'Task stopped.':error instanceof Error?error.message:'Routing failed.';emit({kind:'text',text:failure+'\n'});}
    finally{
      try{saveSession(id,session);}catch{failure='Could not save routed session.';}
      const text=failure??session.transcript.filter(m=>m.role==='assistant').at(-1)?.text??'';
      const result={isError:!!failure,text,tokenUsage:{input,output},durationMs:Date.now()-started,totalCostUsd:null};
      emit({kind:'result',...result});
      const summary:RunSummary={exitCode:failure?1:0,result,killedByStop:abort.signal.aborted,stopEscalation:null,stderr:''};
      emitter.emit('close',summary);settle(summary);
    }
  })());
  return handle;
}
