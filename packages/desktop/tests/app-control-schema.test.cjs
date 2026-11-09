const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');const ts=require('typescript');
const file=path.resolve(__dirname,'../../mcp/src/app-controls.ts');const mod=new Module(file);mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,file);
const controls=mod.exports.APP_CONTROLS;
const source=ts.createSourceFile('bridge.ts',fs.readFileSync(path.resolve(__dirname,'../../api/src/bridge.ts'),'utf8'),ts.ScriptTarget.Latest,true);
const bridge=source.statements.find(s=>ts.isInterfaceDeclaration(s)&&s.name.text==='BridgeChannels');
const channels=new Map(bridge.members.map(m=>[m.name.text,m]));
test('every direct app control targets a real shared channel and provides required handler fields',()=>{
 for(const c of controls.filter(c=>c.channel)){
  assert.ok(channels.has(c.channel),`${c.tool.name}: unknown ${c.channel}`);
  const args=channels.get(c.channel).type.members.find(m=>m.name.text==='args').type;
  if(!ts.isTypeLiteralNode(args))continue;
  const props=c.tool.inputSchema.properties;
  for(const field of args.members){if(!field.questionToken)assert.ok(props[field.name.text],`${c.tool.name}: missing ${field.name.text}`);}
  for(const field of Object.keys(props).filter(k=>!['workspaceId','revision','requestId'].includes(k)))assert.ok(args.members.some(m=>m.name.text===field),`${c.tool.name}: unexpected ${field}`);
 }
});
test('remote controls are unique, bounded and require authority receipts for writes',()=>{
 const names=controls.map(c=>c.tool.name);assert.equal(new Set(names).size,names.length);
 for(const c of controls){assert.equal(c.tool.inputSchema.additionalProperties,false);assert.ok(c.tool.inputSchema.required.includes('workspaceId'));if(c.write){assert.ok(c.tool.inputSchema.required.includes('requestId'));assert.ok(c.tool.inputSchema.required.includes('revision'));}}
});
test('every bridge action has an explicit coordinator route or equivalent',()=>{
 const coordinator=fs.readFileSync(path.resolve(__dirname,'../src/coordinator.ts'),'utf8');
 const names=fs.readFileSync(path.resolve(__dirname,'../../mcp/src/coordinator.ts'),'utf8');
 for(const [channel] of channels){
  const route=controls.find(c=>c.channel===channel);
  const aliases=mod.exports.APP_CONTROL_EQUIVALENTS[channel];
  assert.ok(route||aliases||coordinator.includes(`'${channel}'`),`Unclassified app action: ${channel}`);
  for(const alias of aliases??[])assert.ok(controls.some(c=>c.tool.name===alias)||names.includes(`tool('${alias}'`),`${channel} references missing tool ${alias}`);
 }
});
