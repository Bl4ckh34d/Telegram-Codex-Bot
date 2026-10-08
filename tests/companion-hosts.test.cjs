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
test('local app transport uses the running app without spawning SSH or Codex CLI',async t=>{
 const {file}=fixture(t);fs.writeFileSync(file,JSON.stringify({hosts:{desktop:{transport:'local',label:'PC',icon:'🖥️'}}}));let calls=[];
 const request=createAppTransport(file,{localRequest:async r=>{calls.push(r);return {threads:[{id:'t',kind:'codex'}]};},spawnProcess:()=>{throw new Error('must not spawn');}});
 const result=await request({action:'list'});assert.equal(result.threads[0].companionId,'desktop');assert.equal(result.threads[0].companionIcon,'🖥️');
 await request({action:'send',companionId:'desktop',threadId:'t',text:'hello'});assert.equal(calls.at(-1).text,'hello');
});
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
test('outdated companion cannot silently accept a caption without its attachment',async t=>{
 const {file}=fixture(t);fs.writeFileSync(file,JSON.stringify({hosts:{desktop:{transport:'local'}}}));const calls=[];
 const request=createAppTransport(file,{localRequest:async input=>{calls.push(input.action);return {};}});
 await assert.rejects(request({action:'send',companionId:'desktop',threadId:'t',text:'caption',attachments:[{}]}),/aktualisier|Dateiübertragung/);
 assert.deepEqual(calls,['capabilities']);
});
test('offline host shares exponential backoff capped at ten minutes and recovers with one probe',async t=>{
 const {file}=fixture(t);let clock=1000,offline=true,starts=0,hold=false;const releases=[];
 const request=createAppTransport(file,{now:()=>clock,spawnProcess:()=>{
  starts++;const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();
  c.stdin.end=()=>{const finish=()=>{if(offline){c.stderr.emit('data','connect timed out');c.emit('close',255);}else{c.stdout.emit('data',JSON.stringify({result:{turns:[]}}));c.emit('close',0);}};if(hold)releases.push(finish);else setImmediate(finish);};return c;
 }});
 const read=()=>request({action:'read',companionId:'win',threadId:'t'});
 await read().catch(e=>e);await new Promise(setImmediate);
 for(const delay of [30000,60000,120000,240000,480000,600000,600000]){
  const before=starts;const blocked=await Promise.all(Array.from({length:80},()=>read().catch(e=>e)));
  assert.equal(starts,before);assert.ok(blocked.every(e=>e.code==='DEVICE_OFFLINE'&&e.retryAfterMs===delay));
  clock+=delay-1;await assert.rejects(read(),e=>e.code==='DEVICE_OFFLINE');assert.equal(starts,before);clock++;
  hold=true;const probe=read().catch(e=>e);await new Promise(setImmediate);assert.equal(starts,before+1);
  await assert.rejects(read(),e=>e.code==='DEVICE_OFFLINE');assert.equal(starts,before+1);
  releases.shift()();await probe;await new Promise(setImmediate);hold=false;
 }
 clock+=600000;offline=false;hold=true;const recovered=read();await new Promise(setImmediate);releases.shift()();await recovered;await new Promise(setImmediate);
 const before=starts;const normal=[read(),read()];await new Promise(setImmediate);assert.equal(starts,before+2);while(releases.length)releases.shift()();await Promise.all(normal);
});
test('a missing thread does not mark its reachable companion offline',async t=>{
 const {file}=fixture(t);let starts=0;
 const request=createAppTransport(file,{spawnProcess:()=>{starts++;const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();c.stdin.end=()=>setImmediate(()=>{c.stderr.emit('data','thread not found');c.emit('close',1);});return c;}});
 for(let i=0;i<3;i++)await assert.rejects(request({action:'read',companionId:'win',threadId:'missing'}));assert.equal(starts,3);
});
test('concurrent failures count as one outage, drain queued reads, and leave other hosts available',async t=>{
 const {file}=fixture(t);let clock=1000,offline=true;const starts=[];
 const request=createAppTransport(file,{now:()=>clock,spawnProcess:(_,args)=>{
  const host=args[0];starts.push(host);const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();
  c.stdin.end=()=>setImmediate(()=>{if(host==='win'&&offline){c.emit('close',255);}else{c.stdout.emit('data',JSON.stringify({result:{turns:[]}}));c.emit('close',0);}});return c;
 }});
 const read=host=>request({action:'read',companionId:host,threadId:'t'});
 await Promise.all(Array.from({length:80},()=>read('win').catch(e=>e)));await new Promise(setImmediate);
 assert.equal(starts.filter(h=>h==='win').length,2);await assert.rejects(read('win'),e=>e.retryAfterMs===30000);
 await read('linux');assert.equal(starts.filter(h=>h==='linux').length,1);
 clock+=30000;offline=false;await read('win');await new Promise(setImmediate);
 offline=true;await assert.rejects(read('win'));await new Promise(setImmediate);await assert.rejects(read('win'),e=>e.retryAfterMs===30000);
});
test('file transport sends bytes only to the selected compatible device',async t=>{
 const {file}=fixture(t),calls=[];
 const request=createAppTransport(file,{spawnProcess:(_,args)=>{
  const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin=new EventEmitter();
  c.stdin.end=line=>{const input=JSON.parse(line).input;calls.push({host:args[0],input});setImmediate(()=>{c.stdout.emit('data',JSON.stringify({result:input.action==='capabilities'?{attachments:1}:{ok:true}}));c.emit('close',0);});};return c;
 }});
 const attachments=[{name:'sample.txt',dataBase64:'YWJj',sha256:'hash'}];
 await request({action:'send',companionId:'linux',threadId:'t',text:'caption',attachments,deliveryId:'id'});
 assert.equal(calls.length,2);assert.ok(calls.every(x=>x.host==='linux'));assert.equal(calls[0].input.action,'capabilities');assert.deepEqual(calls[1].input.attachments,attachments);
});
