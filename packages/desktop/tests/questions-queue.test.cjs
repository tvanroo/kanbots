const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const ts=require('typescript');

test('authoritative refresh unlocks a lost reply receipt without replay or stale lock clearing',async()=>{
 const hooks=[];
 const effects=[];
 let cursor=0;
 let rows=[question(1)];
 const pending=[];
 const calls=[];
 const action=async(name,args)=>{
  if(name==='questions-list')return rows;
  calls.push(args.id);
  return new Promise(resolve=>pending.push(resolve));
 };
 const file=path.resolve(__dirname,'../../web/src/components/QuestionsQueue.tsx');
 const module=new Module(file);
 module.require=id=>{
  if(id==='react')return{
   useState(initial){const index=cursor++;hooks[index]??={value:initial};return[hooks[index].value,value=>{hooks[index].value=typeof value==='function'?value(hooks[index].value):value;}];},
   useRef(initial){const index=cursor++;hooks[index]??={current:initial};return hooks[index];},
   useCallback(fn){cursor++;return fn;},
   useEffect(fn){const index=cursor++;if(!hooks[index]){hooks[index]={};effects.push(fn);}},
  };
  if(id==='react/jsx-runtime')return{jsx:element,jsxs:element,Fragment:'fragment'};
  if(id==='../desktop-bridge.js')return{getBridge:()=>({coordinatorAction:action})};
  if(id==='../lib/markdown.js')return{renderMarkdown:text=>text};
  throw Error(id);
 };
 module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022},
 }).outputText,file);
 function render(){cursor=0;return module.exports.QuestionsQueue({inline:true});}
 function element(type,props){return{type,props};}
 function question(id){return{id,threadId:10,runId:10,question:'Question '+id,options:[{value:'yes',label:'Yes '+id}],state:'pending',busy:false};}
 function find(tree,label){
  if(!tree)return undefined;
  if(Array.isArray(tree)){for(const child of tree){const found=find(child,label);if(found)return found;}return;}
  if(typeof tree!=='object')return;
  if(tree.type==='button'&&tree.props.children===label)return tree;
  return find(tree.props?.children,label);
 }
 const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
 render();
 const cleanup=effects.map(effect=>effect());
 try{
  await flush();
  const first=find(render(),'Yes 1');assert.equal(first.props.disabled,false);
  first.props.onClick();await flush();
  assert.equal(find(render(),'Yes 1').props.disabled,true);
  rows=[question(2)];
  find(render(),'Refresh questions').props.onClick();await flush();
  const second=find(render(),'Yes 2');assert.equal(second.props.disabled,false);
  second.props.onClick();await flush();
  // A late completion from question 1 cannot clear question 2's lock.
  pending[0]();await flush();
  assert.equal(find(render(),'Yes 2').props.disabled,true);
  rows=[];
  pending[1]();await flush();
  assert.deepEqual(calls,[1,2]);
  // The original worker can be busy, and several unanswered cards can share
  // its thread. A pending save must disable only its own question.
  rows=Array.from({length:6},(_,i)=>({...question(i+3),busy:true,originBusy:true}));
  find(render(),'Refresh questions').props.onClick();await flush();
  for(let id=3;id<=8;id++){
   const button=find(render(),'Yes '+id);assert.equal(button.props.disabled,false);
   button.props.onClick();await flush();
   assert.equal(find(render(),'Yes '+id).props.disabled,true);
   // Even a stale click handler cannot submit the same question twice.
   button.props.onClick();await flush();
  }
  assert.deepEqual(calls,[1,2,3,4,5,6,7,8]);
  rows=[];for(const resolve of pending.slice(2))resolve();await flush();
  assert.equal(find(render(),'Yes 8'),undefined);
 }finally{
  for(const resolve of pending)resolve();
  await flush();
  for(const stop of cleanup)if(typeof stop==='function')stop();
 }
});
