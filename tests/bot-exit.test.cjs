const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../bot.js'),'utf8');
test('/exit acknowledges and schedules clean shutdown even if Telegram acknowledgement fails',async()=>{
 const start=source.indexOf('async function requestBotExit('),end=source.indexOf('\nasync function ',start+1);
 assert.ok(start>=0,'exit controller exists');
 for(const fails of [false,true]){
  const events=[];let scheduled;
  const context=vm.createContext({botExitRequested:false,log(){},redactError:x=>x,
   cancelPendingRestartRequest:()=>events.push('cancel-restart'),
   sendMessage:async()=>{events.push('ack');if(fails)throw Error('offline');},
   setTimeout:(fn,ms)=>{scheduled=fn;assert.equal(ms,200);},
   shutdown:async(code,reason)=>events.push([code,reason])});
  vm.runInContext(source.slice(start,end),context);
  await context.requestBotExit('chat');assert.equal(context.botExitRequested,true);
  assert.deepEqual(events,['cancel-restart','ack']);await scheduled();
  assert.deepEqual(events.at(-1),[0,'telegram_exit']);
 }
});
test('runtime handler delegates /exit without forwarding it to a model',async()=>{
 let chat;
 const handlers=require('../lib/command_handlers/runtime').createRuntimeCommandHandlers({requestBotExit:async id=>chat=id});
 assert.equal(await handlers['/exit']('topic'),true);assert.equal(chat,'topic');
});
test('explicit exit overrides a racing restart and releases bot resources before process exit',async()=>{
 const start=source.indexOf('async function shutdown('),end=source.indexOf('\nprocess.on("SIGINT"',start);
 const events=[],job={process:{}},lane={queue:['queued']};
 const context=vm.createContext({botExitRequested:true,shuttingDown:false,ttsIdleTimer:null,RESTART_EXIT_CODE:75,AbortController,
   stopTtsControl:()=>events.push('control-stop'),clearInterval(){},logSystemEvent(){},listActiveJobs:()=>[{job}],
   terminateChildTree:()=>events.push('child-stop'),lanes:new Map([['general',lane]]),appChatBridge:{stop:()=>events.push('app-stop')},
   stopTtsKeepalive:()=>events.push('tts-stop'),stopWhisperKeepalive:()=>events.push('whisper-stop'),
   stopWorldMonitorMonitorLoop(){},stopWorldMonitorFeedAlertsLoop(){},stopWeatherDailyLoop(){},
   terminateAllChildren:async()=>events.push('children-finished'),flushChatLogBufferSync(){},persistState(){},flushStatePersistence(){},
   lockHeld:true,LOCK_PATH:'lock',releaseProcessLock:()=>events.push('lock-release'),process:{exit:code=>events.push(['exit',code])}});
 vm.runInContext(source.slice(start,end),context);await context.shutdown(75,'racing restart');
 assert.equal(job.cancelRequested,true);assert.equal(lane.queue.length,0);
 assert.deepEqual(events,['control-stop','child-stop','app-stop','tts-stop','whisper-stop','children-finished','lock-release',['exit',0]]);
});
