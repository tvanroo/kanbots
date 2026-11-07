import {execFile} from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {promisify} from 'node:util';
import {createCodexCliAdapter} from './coordinator-codex-cli.js';
const execute=promisify(execFile);
const executable='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

// Application startup integration, never a tool/renderer-selected command.
// No registration means the existing binding UI continues to say unsupported.
export async function registerMacCodexCliAdapter(register:(adapter:ReturnType<typeof createCodexCliAdapter>)=>void){
  if(process.platform!=='darwin')return {registered:false,reason:'unsupported-platform'};
  try{
    await access(executable,constants.X_OK);
    const {stdout}=await execute(executable,['queue','--help'],{timeout:3000,maxBuffer:16384,encoding:'utf8'});
    if(!stdout.includes('--thread')||!stdout.includes('--message')||!stdout.includes('--resume'))return {registered:false,reason:'unsupported-cli'};
  }catch{return {registered:false,reason:'cli-unavailable'};}
  register(createCodexCliAdapter({executable,localHostId:'local',isDesktopRunning:async()=>{
    try{
      // comm is executable identity, not argv. Do not inspect or log arguments.
      // pgrep -f did not match the live app's argv in the acceptance environment.
      const {stdout}=await execute('/bin/ps',['-axo','comm='],{timeout:500,maxBuffer:524288,encoding:'utf8'});
      return stdout.split('\n').some(line=>line.trim()==='/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
    }catch{throw Error('Desktop availability unknown');}
  }}));
  return {registered:true,reason:'local-cli-queue'};
}
