import Database from 'better-sqlite3';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';

type Box={iv:string;tag:string;data:string};
export type VaultScope = {kind:'all'} | {kind:'project';projectId:string} | {kind:'consumer';projectId:string;consumer:string};
export function validateVaultScopes(value:unknown):VaultScope[]{
 if(!Array.isArray(value)||!value.length||value.length>200)throw Error('Select at least one authorization scope');
 const scopes=value.map((s:any):VaultScope=>{
  if(s?.kind==='all'&&Object.keys(s).length===1)return {kind:'all'};
  if(!s||typeof s.projectId!=='string'||!s.projectId.trim()||s.projectId.length>200)throw Error('Invalid project scope');
  if(s.kind==='project'&&Object.keys(s).length===2)return {kind:'project',projectId:s.projectId};
  if(s.kind==='consumer'&&Object.keys(s).length===3&&typeof s.consumer==='string'&&s.consumer.trim()&&s.consumer.length<=200)return {kind:'consumer',projectId:s.projectId,consumer:s.consumer};
  throw Error('Invalid consumer scope');
 });
 return [...new Map(scopes.map(s=>[JSON.stringify(s),s])).values()];
}
export function vaultScopeAllows(scopes:VaultScope[],project:string,consumer:string){return !!project.trim()&&!!consumer.trim()&&scopes.some(s=>s.kind==='all'||s.projectId===project&&(s.kind==='project'||s.consumer===consumer));}
const aadFor=(r:any)=>JSON.stringify([r.id,r.project,r.name,r.consumer,r.version,...(r.scopes!=null?[r.scopes]:[])]);
export type SecretMetadata={id:string;project:string;name:string;consumer:string;version:number;state:string;createdAt:string;authorizedScopes?:VaultScope[]};
export interface SecretBackend {
  list(project:string):SecretMetadata[];
  withLease<T>(id:string,project:string,consumer:string,ttlMs:number,use:(value:Buffer)=>Promise<T>):Promise<T>;
}
const seal=(key:Buffer,value:Buffer,aad:string):Box=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));return {iv:iv.toString('base64'),data:Buffer.concat([c.update(value),c.final()]).toString('base64'),...{tag:c.getAuthTag().toString('base64')}};};
const open=(key:Buffer,box:Box,aad:string)=>{const d=createDecipheriv('aes-256-gcm',key,Buffer.from(box.iv,'base64'));d.setAAD(Buffer.from(aad));d.setAuthTag(Buffer.from(box.tag,'base64'));return Buffer.concat([d.update(Buffer.from(box.data,'base64')),d.final()]);};
/** Main-process only. Root key is supplied externally, never persisted in this database. */
export class SecretVault implements SecretBackend {
  private db:Database.Database;
  constructor(path:string,private rootKey:()=>Buffer){
    this.db=new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS vault_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY,project TEXT NOT NULL,name TEXT NOT NULL,consumer TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,createdAt TEXT NOT NULL,box TEXT NOT NULL,wrapped TEXT NOT NULL,UNIQUE(project,name,version));
      CREATE TABLE IF NOT EXISTS vault_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,action TEXT NOT NULL,secretId TEXT,actor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vault_leases(id TEXT PRIMARY KEY,secretId TEXT NOT NULL,expiresAt INTEGER NOT NULL,state TEXT NOT NULL);`);
    if(!(this.db.pragma('table_info(secrets)') as any[]).some(c=>c.name==='scopes'))this.db.exec('ALTER TABLE secrets ADD COLUMN scopes TEXT');
  }
  private key(){const key=this.rootKey();if(key.length!==32){key.fill(0);throw Error('Vault requires an external 256-bit key');}return key;}
  initialize(){if(this.db.prepare('SELECT 1 FROM vault_meta').get())throw Error('Vault already initialized');const k=this.key();try{this.db.prepare('INSERT INTO vault_meta VALUES (?,?)').run('verifier',JSON.stringify(seal(k,Buffer.from('KanBorg vault v1'),'verifier')));this.audit('initialize',null,'owner');}finally{k.fill(0);}}
  private verify(){const r=this.db.prepare('SELECT value FROM vault_meta WHERE key=?').get('verifier') as any;if(!r)throw Error('Vault not initialized; explicit owner setup required');const k=this.key();try{if(open(k,JSON.parse(r.value),'verifier').toString()!=='KanBorg vault v1')throw Error();}catch{ k.fill(0);throw Error('Vault key unavailable or incorrect; existing secrets preserved');}return k;}
  private audit(action:string,id:string|null,actor:string){this.db.prepare('INSERT INTO vault_audit(at,action,secretId,actor) VALUES (?,?,?,?)').run(new Date().toISOString(),action,id,actor);}
  list(project:string):SecretMetadata[]{return this.db.prepare('SELECT id,project,name,consumer,version,state,createdAt,scopes FROM secrets WHERE project=? ORDER BY name,version').all(project).map((r:any)=>{const {scopes,...meta}=r;return {...meta,authorizedScopes:scopes==null?[{kind:'consumer',projectId:r.project,consumer:r.consumer}]:validateVaultScopes(JSON.parse(scopes))};}) as SecretMetadata[];}
  stage(project:string,name:string,consumer:string,value:Buffer,authorizedScopes?:VaultScope[]){
    const scopes=authorizedScopes===undefined?null:JSON.stringify(validateVaultScopes(authorizedScopes));
    if(!project.trim()||!name.trim()||!consumer.trim()||!value.length||value.length>65536)throw Error('Project, name, consumer and a bounded secret are required');
    const root=this.verify(),dataKey=randomBytes(32);
    try{return this.db.transaction(()=>{
      const version=((this.db.prepare('SELECT MAX(version) AS v FROM secrets WHERE project=? AND name=?').get(project,name) as any).v??0)+1;
      const meta={id:randomUUID(),project,name,consumer,version,state:'staged',createdAt:new Date().toISOString()};
      const aad=aadFor({...meta,scopes});
      this.db.prepare('INSERT INTO secrets(id,project,name,consumer,version,state,createdAt,box,wrapped,scopes) VALUES (?,?,?,?,?,?,?,?,?,?)').run(meta.id,project,name,consumer,version,meta.state,meta.createdAt,JSON.stringify(seal(dataKey,value,aad)),JSON.stringify(seal(root,dataKey,aad+':key')),scopes);
      this.audit('stage',meta.id,'owner');return meta;
    })();}finally{root.fill(0);dataKey.fill(0);}
  }
  activate(id:string){const root=this.verify();try{this.db.transaction(()=>{const row=this.row(id);if(!['staged','retired'].includes(row.state))throw Error('Only a staged or retained version can be activated');const aad=aadFor(row);const key=open(root,JSON.parse(row.wrapped),aad+':key');try{const value=open(key,JSON.parse(row.box),aad);value.fill(0);}finally{key.fill(0);}this.db.prepare("UPDATE secrets SET state='retired' WHERE project=? AND name=? AND state='active'").run(row.project,row.name);this.db.prepare("UPDATE secrets SET state='active' WHERE id=?").run(id);this.audit('activate',id,'owner');})();}finally{root.fill(0);}}
  revoke(id:string){const root=this.verify();root.fill(0);this.db.transaction(()=>{this.row(id);this.db.prepare("UPDATE secrets SET state='revoked' WHERE id=?").run(id);this.db.prepare("UPDATE vault_leases SET state='revoked' WHERE secretId=? AND state='active'").run(id);this.audit('revoke',id,'owner');})();}
  private row(id:string):any{const r=this.db.prepare('SELECT * FROM secrets WHERE id=?').get(id);if(!r)throw Error('Secret not found');return r;}
  async withLease<T>(id:string,project:string,consumer:string,ttlMs:number,use:(value:Buffer)=>Promise<T>):Promise<T>{
    if(!Number.isInteger(ttlMs)||ttlMs<1||ttlMs>60000)throw Error('Lease must be between 1 and 60000 milliseconds');
    const row=this.row(id);if(row.state!=='active'||!(row.scopes==null?row.project===project&&row.consumer===consumer:vaultScopeAllows(validateVaultScopes(JSON.parse(row.scopes)),project,consumer)))throw Error('Secret unavailable for this consumer');
    const root=this.verify(),aad=aadFor(row);let value:Buffer|undefined,key:Buffer|undefined;const lease=randomUUID();let timer:ReturnType<typeof setTimeout>|undefined;
    try{key=open(root,JSON.parse(row.wrapped),aad+':key');value=open(key,JSON.parse(row.box),aad);
      this.db.prepare('INSERT INTO vault_leases VALUES (?,?,?,?)').run(lease,id,Date.now()+ttlMs,'active');this.audit('lease',id,consumer);
      const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{value?.fill(0);reject(Error('Secret lease expired'));},ttlMs);});
      return await Promise.race([use(value),expired]);
    }finally{if(timer)clearTimeout(timer);value?.fill(0);key?.fill(0);root.fill(0);this.db.prepare("UPDATE vault_leases SET state='closed' WHERE id=? AND state='active'").run(lease);}
  }
  auditLog(){return this.db.prepare('SELECT * FROM vault_audit ORDER BY seq DESC LIMIT 100').all();}
  verifyContents(){
    const root=this.verify();let count=0;
    try{for(const row of this.db.prepare('SELECT * FROM secrets').all() as any[]){
      const aad=aadFor(row);
      const key=open(root,JSON.parse(row.wrapped),aad+':key');
      try{const value=open(key,JSON.parse(row.box),aad);value.fill(0);count++;}finally{key.fill(0);}
    }return {versions:count,verified:true};}finally{root.fill(0);}
  }
  async backup(path:string){this.verifyContents();await this.db.backup(path);const copy=new SecretVault(path,this.rootKey);try{return copy.verifyContents();}finally{copy.close();}}

  close(){this.db.close();}
}
