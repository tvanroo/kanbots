// Launch the real packaged app with isolated settings and verify its renderer loads.
// Usage: node scripts/smoke-packaged.cjs /path/to/Kanbots\ Local.app/Contents/MacOS/Kanbots\ Local
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
(async()=>{
 const binary=process.argv[2];if(!binary)throw Error('Packaged executable path required');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kanbots-launch-check-'));
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(binary,[`--user-data-dir=${root}`,`--remote-debugging-port=${port}`],{env,stdio:['ignore','pipe','pipe']});
 let logs='',socket;child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 try{
  let page;const until=Date.now()+25000;
  while(Date.now()<until){
   if(child.exitCode!==null)throw Error(`Application exited with ${child.exitCode}`);
   try{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();page=pages.find(p=>p.type==='page'&&p.url.startsWith('file:'));if(page)break;}catch{}
   await new Promise(r=>setTimeout(r,250));
  }
  if(!page)throw Error('Packaged application did not open its window');
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  let id=0;const pending=new Map();socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
  const call=(method,params)=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});socket.send(JSON.stringify({id:requestId,method,params}));});
  let state;
  while(Date.now()<until){
   const r=await call('Runtime.evaluate',{expression:'JSON.stringify({ready:document.readyState,text:document.body.innerText,bridge:!!window.kanbots})',returnByValue:true});
   if(r.exceptionDetails)throw Error('Renderer evaluation failed');state=JSON.parse(r.result.value);
   if(state.ready==='complete'&&state.text.length>20&&state.bridge)break;
   await new Promise(r=>setTimeout(r,250));
  }
  if(!state?.bridge||state.text.length<=20)throw Error('Renderer or desktop bridge failed to initialize');
  if(/Uncaught Exception|ERR_INVALID_ARG_VALUE|Error launching app/.test(logs))throw Error('Main-process startup exception');
  console.log(JSON.stringify({launched:true,rendererReady:state.ready,desktopBridge:state.bridge,visibleText:state.text.slice(0,600)}));
 }finally{socket?.close();child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
