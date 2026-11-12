const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const file=path.resolve(__dirname,'../../web/src/components/board/board-status.ts'),m=new Module(file);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,file);
test('board summaries distinguish workflow waits from live workers and deduplicate run IDs',()=>{
 const items=[{number:1,agent:'running',activeRun:{id:9,status:'running'}},{number:2,agent:'blocked',activeRun:{id:10,status:'awaiting_input'}},{number:3,activeRun:null},{number:4,activeRun:{id:9,status:'running'}},{number:5,agent:'running',activeRun:{id:11,status:'stopped'}}];
 assert.deepEqual(m.exports.boardStatus(items,{3:{waiting:{reason:'CI'}}}),{runs:1,awaiting:1,waitingCards:2});
 assert.deepEqual(m.exports.boardStatus(items.filter(i=>i.number===3),{3:{waiting:{reason:'CI'}}}),{runs:0,awaiting:0,waitingCards:1});
});
