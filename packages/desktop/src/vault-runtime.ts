import {app,safeStorage,dialog} from 'electron';
import {existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,rmSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {SecretVault} from './secret-vault.js';
// An explicitly initialized, OS-protected wrapping key lives outside the vault DB.
// Deployments may instead inject KANBORG_VAULT_KEY (base64) into the app process.
const root=()=>join(app.getPath('userData'),'vault');
function key(){
 const injected=process.env.KANBORG_VAULT_KEY;
 if(injected)return Buffer.from(injected,'base64');
 const file=join(root(),'root-key.enc');
 if(!existsSync(file)||!safeStorage.isEncryptionAvailable())throw Error('Vault key unavailable. Restore the existing key; do not create a replacement.');
 return Buffer.from(safeStorage.decryptString(readFileSync(file)),'base64');
}
async function performVaultAction(action:string,args:any,project:string){
 const db=join(root(),'secrets.sqlite');
 if(action==='restore'){
  const chosen=await dialog.showOpenDialog({title:'Choose a KanBorg encrypted recovery folder',properties:['openDirectory']});
  if(chosen.canceled)return {initialized:existsSync(db),cancelled:true,items:[],audit:[]};
  const folder=chosen.filePaths[0]!,manifest=JSON.parse(readFileSync(join(folder,'recovery.json'),'utf8'));
  if(manifest.format!==1||!['external','os-protected'].includes(manifest.keyMode))throw Error('Unsupported recovery package');
  if(manifest.keyMode==='os-protected'&&process.env.KANBORG_VAULT_KEY)throw Error('An external key is configured; remove that override before restoring an OS-protected vault');
  if(manifest.keyMode==='external'&&!process.env.KANBORG_VAULT_KEY)throw Error('Configure the original external vault key before restoring this package');
  const restoreKey=()=>manifest.keyMode==='external'?key():Buffer.from(safeStorage.decryptString(readFileSync(join(folder,'root-key.enc'))),'base64');
  const candidate=new SecretVault(join(folder,'secrets.sqlite'),restoreKey);
  let verification;try{verification=candidate.verifyContents();}finally{candidate.close();}
  const answer=await dialog.showMessageBox({type:'warning',buttons:['Cancel','Restore verified vault'],defaultId:0,cancelId:0,message:'Restore this verified vault?',detail:'The current vault and wrapping key will be retained in a recovery folder. Existing consumer credentials are not migrated.'});
  if(answer.response!==1)return {initialized:existsSync(db),cancelled:true,items:[],audit:[]};
  // Build a complete replacement beside the current vault before a directory swap.
  const staging=root()+'.restore-'+randomUUID();mkdirSync(staging,{mode:0o700});
  try{
   copyFileSync(join(folder,'secrets.sqlite'),join(staging,'secrets.sqlite'));
   if(manifest.keyMode==='os-protected')copyFileSync(join(folder,'root-key.enc'),join(staging,'root-key.enc'));
   const stagedKey=()=>manifest.keyMode==='external'?key():Buffer.from(safeStorage.decryptString(readFileSync(join(staging,'root-key.enc'))),'base64');
   const stagedVault=new SecretVault(join(staging,'secrets.sqlite'),stagedKey);try{stagedVault.verifyContents();}finally{stagedVault.close();}
   const previous=root()+'.previous-'+randomUUID();const hadPrevious=existsSync(root());
   if(hadPrevious)renameSync(root(),previous);
   try{renameSync(staging,root());}catch(e){if(hadPrevious)renameSync(previous,root());throw e;}
   return {initialized:true,items:[],audit:[],recovery:{...verification,path:root(),note:'Restored. Refresh to load metadata. Previous vault retained.'}};
  }catch{rmSync(staging,{recursive:true,force:true});throw Error('Restore failed; original vault preserved');}
 }
 if(action==='status'&&!existsSync(db))return {initialized:false,project,items:[],audit:[]};
 if(action==='initialize'){
  if(existsSync(db))throw Error('Vault already exists; unlock or restore it instead');
  if(process.env.KANBORG_VAULT_KEY&&Buffer.from(process.env.KANBORG_VAULT_KEY,'base64').length!==32)throw Error('External vault key must be 256 bits');
  mkdirSync(root(),{recursive:true,mode:0o700});
  const file=join(root(),'root-key.enc');
  if(!process.env.KANBORG_VAULT_KEY&&!existsSync(file)){
   if(!safeStorage.isEncryptionAvailable())throw Error('OS encrypted key storage unavailable. Configure an external vault key first.');
   const k=randomBytes(32);try{writeFileSync(file,safeStorage.encryptString(k.toString('base64')),{mode:0o600,flag:'wx'});}finally{k.fill(0);}
  }
 }
 if(!existsSync(db)&&action!=='initialize')throw Error('Initialize the vault in Settings first');
 const v=new SecretVault(db,key);
 try{
  if(action==='backup'){
   const chosen=await dialog.showOpenDialog({title:'Choose a folder for the encrypted recovery package',properties:['openDirectory','createDirectory']});
   if(chosen.canceled)return {initialized:true,project,items:v.list(project),audit:v.auditLog().filter((e:any)=>!e.secretId||v.list(project).some(s=>s.id===e.secretId)),cancelled:true};
   const folder=join(chosen.filePaths[0]!,'KanBorg-vault-'+randomUUID());mkdirSync(folder,{mode:0o700});
   try{
    const verification=await v.backup(join(folder,'secrets.sqlite'));
    const keyFile=join(root(),'root-key.enc');
    if(!process.env.KANBORG_VAULT_KEY)copyFileSync(keyFile,join(folder,'root-key.enc'));
    writeFileSync(join(folder,'recovery.json'),JSON.stringify({format:1,keyMode:process.env.KANBORG_VAULT_KEY?'external':'os-protected',...verification}),{mode:0o600});
    return {initialized:true,project,items:v.list(project),audit:v.auditLog().filter((e:any)=>!e.secretId||v.list(project).some(s=>s.id===e.secretId)),recovery:{path:folder,...verification,note:'Keep the original external key or this Mac’s Keychain. This package contains no plaintext secrets.'}};
   }catch{rmSync(folder,{recursive:true,force:true});throw Error('Recovery package could not be verified; existing vault unchanged');}
  }

  if(action==='initialize')v.initialize();
  else if(action==='stage'){
   const value=Buffer.from(String(args.value??''));try{v.stage(project,String(args.name??''),String(args.consumer??''),value);}finally{value.fill(0);}
  }else if(action==='activate'||action==='revoke'){
   if(!v.list(project).some(s=>s.id===args.id))throw Error('Secret is outside this project');
   v[action](args.id);
  }else if(action!=='status')throw Error('Unsupported vault action');
  return {initialized:true,project,items:v.list(project),audit:v.auditLog().filter((e:any)=>!e.secretId||v.list(project).some(s=>s.id===e.secretId))};
 }finally{v.close();}
}

/** Trusted main-process consumers only; never expose this callback through MCP/IPC. */
export async function withVaultSecret<T>(id:string,project:string,consumer:string,use:(value:Buffer)=>Promise<T>):Promise<T>{
 if(vaultBusy)throw Error('Vault recovery is in progress');
 const db=join(root(),'secrets.sqlite');if(!existsSync(db))throw Error('Vault unavailable');
 const v=new SecretVault(db,key);activeUses++;try{return await v.withLease(id,project,consumer,30000,use);}finally{v.close();activeUses--;}
}

let vaultBusy=false;
let activeUses=0;
export async function vaultAction(action:string,args:any,project:string){
 if(vaultBusy)throw Error('Another vault operation is in progress; retry shortly');
 if(action==='restore'&&activeUses)throw Error('Wait for active credential leases before restoring');
 vaultBusy=true;try{return await performVaultAction(action,args,project);}finally{vaultBusy=false;}
}
