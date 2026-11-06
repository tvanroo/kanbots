// Exercise the exact 1.2.13 detached installer with a real replacement bundle.
// Uses a disposable old-app stub, repository and user profile; never touches Applications.
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const Module=require('node:module');const ts=require('typescript');const {execFileSync,spawn}=require('node:child_process');
(async()=>{
 const bundle=process.argv[2];if(!bundle)throw Error('Packaged app bundle required');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kanborg legacy update '));
 const profile=path.join(root,'profile with spaces'),job=path.join(profile,'updates','legacy-test'),repo=path.join(root,'project'),target=path.join(root,'KanBorg.app'),stage=path.join(root,'stage');
 fs.mkdirSync(job,{recursive:true});fs.mkdirSync(repo);fs.mkdirSync(stage);
 execFileSync('git',['init',repo],{stdio:'ignore'});fs.writeFileSync(path.join(repo,'README.md'),'# Recovery fixture\n');execFileSync('git',['-C',repo,'add','.']);execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Initial'],{stdio:'ignore'});
 const oldBinary=path.join(target,'Contents/MacOS/KanBorg');fs.mkdirSync(path.dirname(oldBinary),{recursive:true});fs.writeFileSync(oldBinary,'#!/bin/sh\nexit 0\n',{mode:0o700});
 execFileSync('/usr/bin/ditto',[bundle,path.join(stage,'KanBorg.app')]);
 const source=execFileSync('git',['show','3f952e785bc41584fd1175777d4856caa6ec54fe:packages/desktop/src/self-update.ts'],{encoding:'utf8'});
 const mod=new Module(__filename);mod.paths=module.paths;const req=mod.require.bind(mod);mod.require=id=>id==='electron'?{app:{}}:req(id);mod._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,__filename);
 const script=path.join(job,'legacy-helper.sh');fs.writeFileSync(script,mod.exports.UPDATE_HELPER);
 const version=require('../package.json').version;
 fs.writeFileSync(path.join(profile,'application-update.json'),JSON.stringify({id:'legacy-test',phase:'installing',version,fromVersion:'1.2.13',repoPath:repo,target,stage,job,requestedAt:new Date().toISOString()}));
 let helper;
 try{
  helper=spawn('/bin/sh',[script,'99999999',target,path.join(stage,'KanBorg.app'),path.join(stage,'previous.app'),job,'legacy-test',profile],{stdio:'ignore'});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Legacy update timed out')),105000);helper.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Legacy helper failed: '+code));});helper.once('error',reject);});
  const receipt=JSON.parse(fs.readFileSync(path.join(profile,'application-update.json'),'utf8'));const startup=JSON.parse(fs.readFileSync(path.join(job,'startup.json'),'utf8'));const registry=JSON.parse(fs.readFileSync(path.join(profile,'coordinators.json'),'utf8'));
  if(receipt.phase!=='completed'||!startup.recoveryTokenMatches||!registry.workspaces.some(w=>fs.realpathSync(w.path)===fs.realpathSync(repo)))throw Error('Legacy update did not restore its project and confirm health');
  console.log(JSON.stringify({legacyInstaller:'1.2.13',installedVersion:version,healthConfirmed:true,isolatedProfilePreserved:true,projectRestored:true}));
 }finally{
  if(helper?.exitCode===null)helper.kill('SIGTERM');
  const startupFile=path.join(job,'startup.json');if(fs.existsSync(startupFile)){const {pid}=JSON.parse(fs.readFileSync(startupFile,'utf8'));try{const command=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'});if(command.includes(target+'/Contents/MacOS/KanBorg'))process.kill(pid,'SIGTERM');}catch{}}
  await new Promise(r=>setTimeout(r,2000));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:300});
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
