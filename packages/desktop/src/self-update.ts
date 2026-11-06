import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export type UpdateRecord = { id:string; phase:'staging'|'waiting'|'installing'|'completed'|'failed'|'cancelled'; version:string; fromVersion:string; repoPath:string; target:string; stage:string; job:string; error?:string; requestedAt:string; completedAt?:string };
export function newerVersion(candidate:string,current:string){
  const parse=(v:string)=>/^\d+\.\d+\.\d+$/.test(v)?v.split('.').map(Number):null;
  const a=parse(candidate),b=parse(current);if(!a||!b)return false;
  for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]!>b[i]!;}return false;
}
export const UPDATE_HELPER = `#!/bin/sh
set -eu
oldpid="$1"; target="$2"; staged="$3"; backup="$4"; job="$5"; token="$6"; data="$7"
i=0
while kill -0 "$oldpid" 2>/dev/null; do
  i=$((i+1)); if [ "$i" -ge 120 ]; then echo 'failed: app did not exit' > "$job/helper-status"; exit 1; fi
  sleep 1
done
if ! /bin/mv "$target" "$backup"; then echo 'failed: could not preserve old app' > "$job/helper-status"; exit 1; fi
if ! /bin/mv "$staged" "$target"; then
  /bin/mv "$backup" "$target"
  echo rolled-back > "$job/helper-status"
  "$target/Contents/MacOS/KanBorg" --user-data-dir "$data" >> "$job/launch.log" 2>&1 &
  exit 1
fi
echo launching > "$job/helper-status"
"$target/Contents/MacOS/KanBorg" --kanborg-update-token "$token" --user-data-dir "$data" >> "$job/launch.log" 2>&1 &
newpid=$!
i=0
while [ "$i" -lt 90 ]; do
  if [ -f "$job/healthy" ]; then echo completed > "$job/helper-status"; exit 0; fi
  if ! kill -0 "$newpid" 2>/dev/null; then break; fi
  i=$((i+1)); sleep 1
done
kill "$newpid" 2>/dev/null || true
sleep 2
if kill -0 "$newpid" 2>/dev/null; then echo 'failed: replacement is still running; retained backup' > "$job/helper-status"; exit 1; fi
/bin/mv "$target" "$job/failed.app"
/bin/mv "$backup" "$target"
echo rolled-back > "$job/helper-status"
"$target/Contents/MacOS/KanBorg" --user-data-dir "$data" >> "$job/launch.log" 2>&1 &
`;

/** GitHub release updates plus explicit local DMGs. No credentials or user-data migration. */
export class SelfUpdater {
  private record:UpdateRecord|null=null;
  private busy=false;
  private preparing=false;
  private preparationError:string|null=null;
  private lastCheck:any=null;
  private file:string;
  constructor(private root=app.getPath('userData')){
    this.file=join(root,'application-update.json');
    if(existsSync(this.file))this.record=JSON.parse(readFileSync(this.file,'utf8'));
    if(this.record?.phase==='staging'){this.record.phase='failed';this.record.error='Staging was interrupted. Request the update again.';this.save();}
  }
  private save(){writeFileSync(this.file+'.tmp',JSON.stringify(this.record),{mode:0o600});renameSync(this.file+'.tmp',this.file);}
  status(){
    if(this.record?.phase==='installing'&&existsSync(join(this.record.job,'helper-status'))){
      const status=readFileSync(join(this.record.job,'helper-status'),'utf8').trim();
      if(status==='rolled-back'||status.startsWith('failed:')){this.record.phase='failed';this.record.error=status==='rolled-back'?'The replacement did not start. The previous app was restored.':status;this.save();}
    }
    return {preparing:this.preparing,error:this.preparationError,available:this.lastCheck,currentVersion:app.getVersion(),supported:process.platform==='darwin'&&app.isPackaged,update:this.record};
  }
  async check(){
    this.lastCheck=null;
    const response=await fetch('https://api.github.com/repos/tvanroo/kanbots/releases/latest',{headers:{Accept:'application/vnd.github+json','User-Agent':'KanBorg-Updater'},signal:AbortSignal.timeout(15000)});
    if(response.status===404)return {...this.status(),available:null,message:'No published KanBorg release yet.'};
    if(!response.ok)throw Error(`Could not check GitHub releases (${response.status}). Try again later.`);
    const release=await response.json() as any;
    const asset=release.assets?.find((a:any)=>a.name==='kanborg-update.json');
    if(!asset)return {...this.status(),available:null,message:'The latest release does not include an update manifest.'};
    const trusted=(url:unknown)=>typeof url==='string'&&url.startsWith('https://github.com/tvanroo/kanbots/releases/download/');
    if(!trusted(asset.browser_download_url))throw Error('Unexpected release location.');
    const manifestResponse=await fetch(asset.browser_download_url,{signal:AbortSignal.timeout(15000)});
    if(!manifestResponse.ok)throw Error('Could not read the release manifest.');
    const manifest=await manifestResponse.json() as any;
    if(typeof manifest.file!=='string'||basename(manifest.file)!==manifest.file||!manifest.file.endsWith(`mac-${process.arch}.dmg`)||! /^[a-f0-9]{64}$/i.test(manifest.sha256??'')||! /^\d+\.\d+\.\d+$/.test(manifest.version??''))throw Error('No valid update for this Mac in the release manifest.');
    const installer=release.assets?.find((a:any)=>a.name===manifest.file);
    if(!installer||!trusted(installer.browser_download_url))throw Error('The release installer is missing.');
    this.lastCheck=newerVersion(manifest.version,app.getVersion())?{version:manifest.version,url:installer.browser_download_url,sha256:manifest.sha256,file:manifest.file}:null;return this.status();
  }
  pending(){return this.preparing||this.record?.phase==='waiting'||this.record?.phase==='installing';}
  enqueue(a:{action:string;packagePath?:string;sha256?:string;version?:string},repoPath:string){
    if(this.preparing)throw Error('An update is being prepared. Check its progress shortly.');
    if(a.action==='cancel')return this.request(a,repoPath);
    const task=this.request(a,repoPath);this.preparing=true;this.preparationError=null;
    void task.catch(e=>{this.preparationError=e instanceof Error?e.message:'Could not prepare update';}).finally(()=>{this.preparing=false;});
    return {accepted:true,...this.status(),message:'Preparing the update. Check getApplicationUpdate for progress; do not start another installation.'};
  }
  async request(a:{action:string;packagePath?:string;sha256?:string;version?:string},repoPath:string){
    if(this.busy)throw Error('An update operation is already in progress.');
    if(a.action==='cancel'){
      if(this.record?.phase==='installing')throw Error('Installation has started. Wait for restart.');
      if(this.record?.phase==='waiting'){this.record.phase='cancelled';this.save();await rm(this.record.stage,{recursive:true,force:true});}
      return this.status();
    }
    if(process.platform!=='darwin'||!app.isPackaged)throw Error('Self-update is available in the installed macOS app.');
    if(this.pending())throw Error('An update is already queued. Check its status or cancel it first.');
    let downloaded:string|undefined;
    if(!a.packagePath){
      this.busy=true;
      try{
        const available=(await this.check()).available;if(!available)throw Error('No newer release is available.');
        if(a.version&&a.version!==available.version)throw Error('The available release changed. Check updates again before installing.');
        const downloads=join(this.root,'updates','downloads');mkdirSync(downloads,{recursive:true,mode:0o700});
        downloaded=join(downloads,randomUUID()+'.dmg');
        await exec('/usr/bin/curl',['--fail','--location','--silent','--show-error','--proto','=https','--proto-redir','=https','--max-time','180','--output',downloaded,available.url],{timeout:190000});
        a={...a,version:available.version,sha256:available.sha256,packagePath:downloaded};
      }catch(e){if(downloaded)await rm(downloaded,{force:true});throw e;}finally{this.busy=false;}
    }
    if(!a.packagePath||!a.packagePath.startsWith('/')||!a.packagePath.endsWith('.dmg')||!a.sha256||! /^[a-f0-9]{64}$/i.test(a.sha256)||!a.version||!newerVersion(a.version,app.getVersion()))throw Error('Provide a local DMG path, its SHA-256 and a newer release version.');
    const target=await realpath(resolve(process.execPath,'../../..'));
    if(!target.endsWith('.app')||target.startsWith('/Volumes/'))throw Error('Move KanBorg to Applications before self-updating.');
    await access(dirname(target),constants.W_OK);
    this.busy=true;
    let mount='';
    try{
      const digest=createHash('sha256');for await(const chunk of createReadStream(a.packagePath))digest.update(chunk);
      if(digest.digest('hex').toLowerCase()!==a.sha256.toLowerCase())throw Error('Installer checksum does not match. No update was staged.');
      const id=randomUUID(),job=join(this.root,'updates',id);mkdirSync(job,{recursive:true,mode:0o700});
      const stage=await mkdtemp(join(dirname(target),'.kanborg-update-'));
      this.record={id,phase:'staging',version:a.version,fromVersion:app.getVersion(),repoPath,target,stage,job,requestedAt:new Date().toISOString()};this.save();
      mount=join(job,'mounted');mkdirSync(mount);
      await exec('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,a.packagePath],{timeout:60000});
      const bundle=join(mount,'KanBorg.app'),plist=join(bundle,'Contents/Info.plist');
      const value=async(key:string)=>(await exec('/usr/libexec/PlistBuddy',['-c',`Print :${key}`,plist])).stdout.trim();
      if(await value('CFBundleIdentifier')!=='com.tvanroo.kanbots.local'||await value('CFBundleShortVersionString')!==a.version||await value('CFBundleExecutable')!=='KanBorg')throw Error('Installer identity or version does not match KanBorg.');
      const binary=join(bundle,'Contents/MacOS/KanBorg');
      const arch=(await exec('/usr/bin/lipo',['-archs',binary])).stdout;
      if(!arch.split(/\s+/).includes(process.arch==='arm64'?'arm64':'x86_64'))throw Error('Installer does not support this Mac.');
      await exec('/usr/bin/ditto',[bundle,join(stage,'KanBorg.app')],{timeout:120000});
      this.record.phase='waiting';this.save();return this.status();
    }catch(e){if(this.record?.phase==='staging'){this.record.phase='failed';this.record.error=e instanceof Error?e.message:'Update failed';this.save();}throw e;}
    finally{if(downloaded)await rm(downloaded,{force:true});if(mount)await exec('/usr/bin/hdiutil',['detach',mount],{timeout:30000}).catch(()=>{});this.busy=false;}
  }
  async installWhenIdle(isIdle:()=>Promise<boolean>,checkpoint:()=>Promise<void>){
    if(this.busy||this.record?.phase!=='waiting'||!await isIdle())return;
    this.busy=true;
    try{
      await checkpoint();
      const r=this.record!;r.phase='installing';this.save();
      const script=join(r.job,'install.sh');writeFileSync(script,UPDATE_HELPER,{mode:0o700});
      const child=spawn('/bin/sh',[script,String(process.pid),r.target,join(r.stage,'KanBorg.app'),join(r.stage,'previous.app'),r.job,r.id,this.root],{detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:process.env.HOME}});
      await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
      app.exit(0);
    }catch(e){this.record!.phase='failed';this.record!.error=e instanceof Error?e.message:'Could not restart';this.save();this.busy=false;throw e;}
  }
  recovery(){const r=this.record;return r&&r.phase==='installing'&&r.version===app.getVersion()&&app.commandLine.getSwitchValue('kanborg-update-token')===r.id?r:null;}
  complete(){if(!this.recovery())return;this.record!.phase='completed';this.record!.completedAt=new Date().toISOString();this.save();writeFileSync(join(this.record!.job,'healthy'),'ready',{mode:0o600});}
  failRecovery(message:string){if(this.record){this.record.error=message;this.save();}}
}
