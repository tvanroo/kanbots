const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const Module=require('node:module');const ts=require('typescript');
const file=path.resolve(__dirname,'../src/secret-vault.ts');const m=new Module(file);m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText,file);const {SecretVault}=m.exports;
test('encrypted vault rotation, scope, restore, and failure preserve data',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kanborg-vault-test-'));const key=Buffer.alloc(32,7);let v;
 try{v=new SecretVault(path.join(dir,'vault.db'),()=>Buffer.from(key));assert.throws(()=>v.stage('p','key','worker',Buffer.from('test-secret')),/not initialized/);v.initialize();
 const a=v.stage('p','key','worker',Buffer.from('test-secret'));v.activate(a.id);
 assert.equal(await v.withLease(a.id,'p','worker',1000,async b=>b.toString()),'test-secret');
 await assert.rejects(v.withLease(a.id,'other','worker',1000,async()=>{}),/consumer/);
 const b=v.stage('p','key','worker',Buffer.from('replacement'));assert.equal(v.list('p').find(x=>x.id===a.id).state,'active');v.activate(b.id);assert.equal(v.list('p').find(x=>x.id===a.id).state,'retired');v.activate(a.id);
 let retained;await v.withLease(a.id,'p','worker',1000,async b=>{retained=b;});assert.ok(retained.every(x=>x===0));
 await assert.rejects(v.withLease(a.id,'p','worker',5,async()=>new Promise(r=>setTimeout(r,20))),/expired/);
 const backup=path.join(dir,'backup.db');await v.backup(backup);v.close();v=null;
 assert.ok(!fs.readFileSync(backup).includes(Buffer.from('test-secret')));
 v=new SecretVault(backup,()=>Buffer.alloc(32,8));await assert.rejects(v.withLease(a.id,'p','worker',1000,async()=>{}),/incorrect/);v.close();
 v=new SecretVault(backup,()=>Buffer.from(key));assert.equal(await v.withLease(a.id,'p','worker',1000,async b=>b.toString()),'test-secret');v.revoke(a.id);await assert.rejects(v.withLease(a.id,'p','worker',1000,async()=>{}),/unavailable/);assert.ok(!JSON.stringify(v.auditLog()).includes('test-secret'));
 }finally{v?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('authenticated ciphertext rejects metadata and payload tampering',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kanborg-vault-tamper-')),dbPath=path.join(dir,'vault.db');let v;
 try{v=new SecretVault(dbPath,()=>Buffer.alloc(32,4));v.initialize();const s=v.stage('p','name','trusted',Buffer.from('synthetic-secret'));v.activate(s.id);v.close();
 const Database=m.require('better-sqlite3');const db=new Database(dbPath);db.prepare('UPDATE secrets SET name=? WHERE id=?').run('changed-name',s.id);db.close();
 v=new SecretVault(dbPath,()=>Buffer.alloc(32,4));await assert.rejects(v.withLease(s.id,'p','trusted',1000,async b=>b.toString()));assert.equal(v.list('p')[0].state,'active');
 }finally{v?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('corrupt staged replacement cannot retire the working credential',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kanborg-vault-rotation-')),dbPath=path.join(dir,'vault.db');let v;
 try{v=new SecretVault(dbPath,()=>Buffer.alloc(32,4));v.initialize();const old=v.stage('p','name','trusted',Buffer.from('working'));v.activate(old.id);const next=v.stage('p','name','trusted',Buffer.from('replacement'));v.close();
 const Database=m.require('better-sqlite3');const db=new Database(dbPath);db.prepare('UPDATE secrets SET box=? WHERE id=?').run('{}',next.id);db.close();
 v=new SecretVault(dbPath,()=>Buffer.alloc(32,4));assert.throws(()=>v.activate(next.id));assert.equal(v.list('p').find(s=>s.id===old.id).state,'active');assert.equal(v.list('p').find(s=>s.id===next.id).state,'staged');assert.equal(await v.withLease(old.id,'p','trusted',1000,async b=>b.toString()),'working');
 }finally{v?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('multiple consumer, repository and global grants persist and remain authenticated',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kanborg-vault-scopes-')),file=path.join(dir,'vault.db');let v;
 try{
  v=new SecretVault(file,()=>Buffer.alloc(32,9));v.initialize();
  const scoped=v.stage('owner','multi','Selected consumers',Buffer.from('synthetic'),[{kind:'consumer',projectId:'cardbox',consumer:'importer'},{kind:'consumer',projectId:'cardbox',consumer:'reviewer'},{kind:'project',projectId:'other'}]);v.activate(scoped.id);
  for(const [project,consumer] of [['cardbox','importer'],['cardbox','reviewer'],['other','new-consumer']])assert.equal(await v.withLease(scoped.id,project,consumer,1000,async b=>b.toString()),'synthetic');
  for(const [project,consumer] of [['cardbox','unknown'],['unknown','importer']])await assert.rejects(v.withLease(scoped.id,project,consumer,1000,async()=>{}),/unavailable/);
  assert.equal(v.list('owner')[0].authorizedScopes.length,3);
  await v.backup(path.join(dir,'backup.db'));v.close();v=new SecretVault(path.join(dir,'backup.db'),()=>Buffer.alloc(32,9));
  assert.equal(await v.withLease(scoped.id,'other','future',1000,async b=>b.toString()),'synthetic');
  const all=v.stage('owner','global','All',Buffer.from('synthetic'),[{kind:'all'}]);v.activate(all.id);
  assert.equal(await v.withLease(all.id,'future-repo','future-consumer',1000,async b=>b.toString()),'synthetic');
  await assert.rejects(v.withLease(all.id,'future-repo','',1000,async()=>{}),/unavailable/);
  v.revoke(all.id);await assert.rejects(v.withLease(all.id,'future-repo','future-consumer',1000,async()=>{}),/unavailable/);
  assert.throws(()=>v.stage('owner','bad','scope',Buffer.from('synthetic'),[]),/Select/);
  assert.throws(()=>v.stage('owner','bad','scope',Buffer.from('synthetic'),[{kind:'all',projectId:'unexpected'}]),/Invalid/);
  v.close();v=null;
  const Database=m.require('better-sqlite3'),db=new Database(path.join(dir,'backup.db'));db.prepare('UPDATE secrets SET scopes=? WHERE id=?').run(JSON.stringify([{kind:'all'}]),scoped.id);db.close();
  v=new SecretVault(path.join(dir,'backup.db'),()=>Buffer.alloc(32,9));await assert.rejects(v.withLease(scoped.id,'unapproved','consumer',1000,async()=>{}));
 }finally{v?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
