const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../bot.js'),'utf8');
test('main chat routes once to general; legacy worker commands cannot create workers',async()=>{
 const start=source.indexOf('async function routeAndEnqueuePrompt('),end=source.indexOf('\nfunction ',start);
 const queued=[];const context=vm.createContext({ORCH_GENERAL_WORKER_ID:'general',enqueuePrompt:async(...args)=>queued.push(args)});
 vm.runInContext(source.slice(start,end),context);
 await context.routeAndEnqueuePrompt('1','hello','plain',{workerId:'repo-old',resumeSessionId:'old-worker-session'});
 assert.equal(queued.length,1);assert.equal(queued[0][3].workerId,'general');assert.equal(queued[0][3].resumeSessionId,undefined);
 const messages=[];const handlers=require('../lib/command_handlers/workspace').createWorkspaceCommandHandlers({sendMessage:async(c,t)=>messages.push(t)});
 for(const command of ['/spawn','/use','/retire','/workers','/capabilities'])await handlers[command]('1',{arg:'x'});
 assert.equal(messages.length,5);assert.ok(messages.every(t=>t.includes('/app new')));
});
test('CLI has no router and disables native subagents without changing app config',()=>{
 assert.doesNotMatch(source,/createOrchRouterRuntime/);
 assert.match(source,/execOptions\.push\("-c", "features\.multi_agent=false"\)/);
 assert.match(source,/Do not delegate, spawn subagents/);
 assert.match(source,/deleteTopic: async/);
});
