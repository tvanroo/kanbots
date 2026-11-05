// Launch the real packaged app with isolated settings and verify its renderer loads.
// Usage: node scripts/smoke-packaged.cjs /path/to/Kanbots\ Local.app/Contents/MacOS/Kanbots\ Local
const {spawn,execFileSync}=require('node:child_process');
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
  const call=(method,params)=>new Promise((resolve,reject)=>{const requestId=++id;const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Timed out: '+method));},20000);pending.set(requestId,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket.send(JSON.stringify({id:requestId,method,params}));});
  let state;
  while(Date.now()<until){
   const r=await call('Runtime.evaluate',{expression:'JSON.stringify({ready:document.readyState,text:document.body?.innerText??"",bridge:!!window.kanbots})',returnByValue:true});
   if(r.exceptionDetails)throw Error('Renderer evaluation failed');state=JSON.parse(r.result.value);
   if(state.ready==='complete'&&state.text.length>20&&state.bridge)break;
   await new Promise(r=>setTimeout(r,250));
  }
  if(!state?.bridge||state.text.length<=20)throw Error('Renderer or desktop bridge failed to initialize');
  if(process.argv.includes('--board')){
   const repo=path.join(root,'sample-repository');fs.mkdirSync(repo);execFileSync('git',['init',repo],{stdio:'ignore'});fs.writeFileSync(path.join(repo,'README.md'),'# Sample project\n');execFileSync('git',['-C',repo,'add','README.md']);execFileSync('git',['-C',repo,'-c','user.name=Smoke Test','-c','user.email=smoke@example.invalid','commit','-m','Initial test repository'],{stdio:'ignore'});
   console.log('Opening isolated repository');
   const result=await call('Runtime.evaluate',{expression:`(async()=>{await window.kanbots.cloudPromptDismiss();return window.kanbots.openWorkspace(${JSON.stringify(repo)});})()`,awaitPromise:true,returnByValue:true});
   if(!result.result.value?.ok)throw Error('Test repository could not open');
   console.log('Loading board');await call('Page.reload',{});
   let text='';const deadline=Date.now()+15000;
   while(Date.now()<deadline){try{const r=await call('Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true});text=r.result.value??'';if(text.includes('Populate board from repository')&&text.includes('Your built-in coordinator'))break;}catch{}await new Promise(r=>setTimeout(r,250));}
   if(!text.includes('Populate board from repository')||!text.includes('Connect external coordinator')||!text.includes('Or tell your coordinator what you need'))throw Error('Coordinator onboarding panel is missing');
   const screenshot=await call('Page.captureScreenshot',{format:'png'});const output=path.resolve('output/packaged-board-onboarding.png');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,Buffer.from(screenshot.data,'base64'));
   console.log(JSON.stringify({emptyBoardPrompts:true,screenshot:output}));
   await call('Runtime.evaluate',{expression:"window.dispatchEvent(new CustomEvent('kanbots:open-coordinator'))"});
   await new Promise(r=>setTimeout(r,700));
   await call('Runtime.evaluate',{expression:"window.dispatchEvent(new CustomEvent('kanbots:issues-refetch'))"});
   await new Promise(r=>setTimeout(r,700));
   const chatView=await call('Runtime.evaluate',{expression:"JSON.stringify({open:!!document.querySelector('[aria-label=\"Project coordinator\"][role=\"dialog\"]'),composer:!!document.querySelector('textarea[aria-label=\"Message coordinator\"]'),saved:document.body.innerText.includes('This conversation is saved.')})",returnByValue:true});
   const visible=JSON.parse(chatView.result.value);if(!visible.open||!visible.composer||!visible.saved)throw Error('Coordinator chat disappeared during empty-board refresh');
   const chatImage=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.resolve('output/packaged-coordinator-chat.png'),Buffer.from(chatImage.data,'base64'));console.log(JSON.stringify({coordinatorChatSurvivesRefresh:true}));
   await call('Runtime.evaluate',{expression:"window.kanbots.coordinatorAction('add-client',{name:'DeepSeek Harness'})",awaitPromise:true,returnByValue:true});
   await new Promise(r=>setTimeout(r,3500));
   const setupView=await call('Runtime.evaluate',{expression:"JSON.stringify({step:document.body.innerText.includes('Step 1 of 3'),copy:[...document.querySelectorAll('button')].some(b=>b.offsetParent&&b.textContent==='Copy setup request'),prematureApproval:[...document.querySelectorAll('button')].some(b=>b.offsetParent&&/Approve (pairing|connection)/.test(b.textContent))})",returnByValue:true});
   const setup=JSON.parse(setupView.result.value);if(!setup.step||!setup.copy||setup.prematureApproval)throw Error('Setup does not present one clear current action');
   const setupImage=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.resolve('output/packaged-coordinator-setup.png'),Buffer.from(setupImage.data,'base64'));console.log(JSON.stringify({clearSetupNextAction:true}));


  }
  if(/Uncaught Exception|ERR_INVALID_ARG_VALUE|Error launching app/.test(logs))throw Error('Main-process startup exception');
  console.log(JSON.stringify({launched:true,rendererReady:state.ready,desktopBridge:state.bridge,visibleText:state.text.slice(0,600)}));
 }catch(e){console.error(logs.slice(-3000));throw e;}finally{socket?.close();child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
