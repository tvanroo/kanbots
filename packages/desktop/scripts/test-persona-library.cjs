const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
async function load(path){const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));}
(async()=>{
 const {newPersonaLibrary,editPersonaLibrary}=await load('packages/desktop/src/persona-library.ts');
 const lib=newPersonaLibrary('CardBox');assert.equal(lib.items.length,10);assert.equal(newPersonaLibrary('Other').items.length,5);
 for(const p of lib.items.filter(p=>p.id.startsWith('cardbox:'))){assert.ok(p.prompt.includes('COMPLETION AND ESCALATION'));assert.ok(p.prompt.includes('no credentials'));assert.ok(p.prompt.length>1000);}
 const original=structuredClone(lib.items[0]);
 editPersonaLibrary(lib,'upsert',{persona:{...original,prompt:original.prompt+'\nUpdated scope'},reason:'owner edit'},'test-client',[original.id]);
 assert.equal(lib.items[9].version,2);assert.equal(lib.history[0].previous.prompt,original.prompt);
 assert.throws(()=>editPersonaLibrary(lib,'remove',{id:original.id,reason:'remove'},'test-client',[original.id]),/selection/);
 const version=lib.version;assert.equal(lib.items.length,10);
 editPersonaLibrary(lib,'remove',{id:original.id,reason:'remove'},'test-client',[]);assert.equal(lib.items.length,9);assert.equal(lib.version,version+1);
 assert.deepEqual(JSON.parse(JSON.stringify(lib)),lib);
 const source=fs.readFileSync('packages/web/src/personas.ts','utf8').replace("import { getBridge } from './desktop-bridge.js';",'const getBridge=()=>null;');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const {BUILTIN_PERSONAS,mergeAutopilotPersonas}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const saved=['product-manager','senior-engineer','ux-designer','reliability','catalog-expediter'].map(id=>({id,name:id,prompt:'owner-specific '+id}));
 const merged=mergeAutopilotPersonas([...BUILTIN_PERSONAS],saved);assert.equal(merged.length,6);
 for(const p of saved)assert.equal(merged.find(x=>x.id===p.id).prompt,p.prompt);
 assert.equal(merged.find(p=>p.id==='product-manager').emoji,'🎯');
 assert.deepEqual(mergeAutopilotPersonas([...BUILTIN_PERSONAS],merged.filter(p=>saved.some(s=>s.id===p.id))),merged);
 assert.equal(mergeAutopilotPersonas([...BUILTIN_PERSONAS],[{id:'custom:pm',name:'Product Manager',prompt:'distinct'}]).length,6);
 const {validateCoordinatorArgs}=await import('../../mcp/dist/index.js');
 const args={workspaceId:'test',revision:0,requestId:'test-persona-request',reason:'Owner request',persona:{id:'custom:test',name:'Test',tagline:'Test',emoji:'✨',prompt:'A substantive working contract for the task'}};
 validateCoordinatorArgs('upsertPersona',args);
 assert.throws(()=>validateCoordinatorArgs('upsertPersona',{...args,persona:{...args.persona,prompt:'tiny'}}));
 assert.throws(()=>validateCoordinatorArgs('upsertPersona',{...args,persona:{...args.persona,credentials:'no'}}));
 console.log('PASS: five specialist contracts, scope, version/history, selected deletion guard, persistence, aliases, custom identities, refresh, MCP schema validation');
})().catch(e=>{console.error(e);process.exit(1)});
