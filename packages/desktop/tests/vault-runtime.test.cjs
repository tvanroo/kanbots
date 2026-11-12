const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),ts=require('typescript');
function load(file,mocks={}){const m=new Module(file);m.paths=Module._nodeModulePaths(path.dirname(file));const original=m.require.bind(m);m.require=id=>mocks[id]??original(id);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText,file);return m.exports;}
test('owner recovery package verifies then restores with previous vault retained',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kanborg-vault-ui-'));let directory=root;let alterOnConfirm=false;
 const SecretVault=load(path.resolve(__dirname,'../src/secret-vault.ts'));
 const runtime=load(path.resolve(__dirname,'../src/vault-runtime.ts'),{'./secret-vault.js':SecretVault,electron:{app:{getPath:()=>root},safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[directory]}),showMessageBox:async()=>{if(alterOnConfirm)fs.writeFileSync(path.join(directory,'secrets.sqlite'),'changed while confirming');return {response:1};}}}});
 try{
  assert.equal((await runtime.vaultAction('status',{},'p')).initialized,false);
  await runtime.vaultAction('initialize',{},'p');
  let status=await runtime.vaultAction('stage',{name:'test',consumer:'consumer',value:'synthetic'},'p');
  const id=status.items[0].id;await runtime.vaultAction('activate',{id},'p');
  assert.equal(await runtime.withVaultSecret(id,'p','consumer',async b=>b.toString()),'synthetic');
  const recovery=await runtime.vaultAction('backup',{},'p');assert.equal(recovery.recovery.verified,true);directory=recovery.recovery.path;
  const manifestPath=path.join(directory,'recovery.json');
  const manifest=fs.readFileSync(manifestPath,'utf8');
  fs.writeFileSync(manifestPath,JSON.stringify({...JSON.parse(manifest),keyMode:'external'}));
  await assert.rejects(runtime.vaultAction('restore',{},'p'),/original external vault key/);
  assert.equal(await runtime.withVaultSecret(id,'p','consumer',async b=>b.toString()),'synthetic');
  fs.writeFileSync(manifestPath,manifest);
  const backupBytes=fs.readFileSync(path.join(directory,'secrets.sqlite'));alterOnConfirm=true;
  await assert.rejects(runtime.vaultAction('restore',{},'p'),/original vault preserved/);
  assert.equal(await runtime.withVaultSecret(id,'p','consumer',async b=>b.toString()),'synthetic');
  fs.writeFileSync(path.join(directory,'secrets.sqlite'),backupBytes);alterOnConfirm=false;
  await runtime.vaultAction('revoke',{id},'p');
  await runtime.vaultAction('restore',{},'p');
  assert.equal(await runtime.withVaultSecret(id,'p','consumer',async b=>b.toString()),'synthetic');
  assert.ok(fs.readdirSync(root).some(n=>n.startsWith('vault.previous-')));
  await assert.rejects(runtime.vaultAction('revoke',{id},'other'),/outside/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
