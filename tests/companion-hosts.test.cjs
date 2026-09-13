const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {loadCompanionHosts}=require('../lib/companion_hosts');
const {createAppTransport}=require('../lib/companion_app_transport');
const {createAppChatBridge,groupAppThreads}=require('../lib/app_chat_bridge');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hosts-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'hosts.json');fs.writeFileSync(file,JSON.stringify({hosts:{win:{destination:'win',remote_command:'request'},linux:{destination:'linux',remote_command:'request'}}}));return {dir,file};}
test('multiple hosts require an explicit target and do not expose SSH configuration',t=>{
 const {file}=fixture(t),hosts=loadCompanionHosts(file);
 assert.throws(()=>hosts.get(),/explicitly/);assert.throws(()=>hosts.get('missing'),/Unknown/);
 assert.deepEqual(hosts.list(),[{id:'win',label:'win'},{id:'linux',label:'linux'}]);
 assert.equal(hosts.get('linux').config.destination,'linux');
});
test('legacy single-host configuration and referenced host files remain supported',t=>{
 const {dir,file}=fixture(t);const legacy=path.join(dir,'legacy.json');
 fs.writeFileSync(legacy,JSON.stringify({destination:'windows',remote_command:'request'}));
 assert.equal(loadCompanionHosts(legacy).get().config.destination,'windows');
 fs.writeFileSync(file,JSON.stringify({default_host:'win',hosts:{win:{config_path:'legacy.json'}}}));
 assert.equal(loadCompanionHosts(file).get().config.destination,'windows');
});
test('identical app thread IDs on different computers stay separate through selection and send',async t=>{
 const {dir,file}=fixture(t);const calls=[];
 const request=createAppTransport(file,{spawnProcess:(_,args)=>{
  const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();
  c.stdin.end=line=>{const input=JSON.parse(line).input;calls.push({host:args[0],input});setImmediate(()=>{
   const result=input.action==='list'?{threads:[{id:'same',kind:'codex',hostId:'local',title:'Project',cwd:'/repo'}]}:input.action==='read'?{turns:[]}:{};
   c.stdout.emit('data',JSON.stringify({result}));c.emit('close',0);
  });};return c;
 }});
 const listed=await request({action:'list'});
 assert.equal(groupAppThreads(listed).rows.length,2);
 const bridge=createAppChatBridge({filePath:path.join(dir,'bindings.json'),request,sendText:async()=>{},speak:async()=>{},interruptSpeech(){},validPreset:()=>true});
 await bridge.command('chat','list');await bridge.command('chat','use 2');await bridge.route('chat','Hello');
 assert.equal(bridge.target('chat').companionId,'linux');
 assert.equal(calls.at(-1).host,'linux');assert.equal(calls.at(-1).input.hostId,'local');
});
test('many topic reads are bounded per host while queued sends retain order and are never retried',async t=>{
 const {file}=fixture(t);let active=0,peak=0;const started=[],release=[];
 const request=createAppTransport(file,{spawnProcess:()=>{
  const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();
  c.stdin.end=line=>{const input=JSON.parse(line).input;active++;peak=Math.max(peak,active);started.push(input);
   release.push(()=>{active--;c.stdout.emit('data',JSON.stringify({result:{turns:[]}}));c.emit('close',0);});};return c;
 }});
 const pending=Array.from({length:13},(_,i)=>request({action:'read',threadId:String(i),companionId:'win'}));
 await new Promise(setImmediate);assert.equal(started.length,2);
 pending.push(request({action:'send',text:'first',companionId:'win'}),request({action:'send',text:'second',companionId:'win'}));
 release.shift()();await new Promise(setImmediate);assert.equal(started[2].text,'first');
 release.shift()();await new Promise(setImmediate);assert.equal(started[3].text,'second');
 while(release.length){release.shift()();await new Promise(setImmediate);}
 await Promise.all(pending);assert.equal(peak,2);assert.equal(started.length,15);
});
test('read failures provide safe diagnostics; uncertain sends are not retried',async t=>{
 const {file}=fixture(t);let count=0;
 const request=createAppTransport(file,{spawnProcess:()=>{
  count++;const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();
  c.stdin.end=()=>setImmediate(()=>{c.stderr.emit('data','kex_exchange_identification: Connection reset secret-token');c.emit('close',255);});return c;
 }});
 await assert.rejects(request({action:'read',companionId:'win'}),e=>/SSH-Verbindung/.test(e.message)&&!/secret-token|Zustellung/.test(e.message));
 await assert.rejects(request({action:'send',companionId:'win'}),/Zustellung unklar/);assert.equal(count,2);
});
