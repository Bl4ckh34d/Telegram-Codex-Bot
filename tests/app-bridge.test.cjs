const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAppChatBridge,groupAppThreads}=require('../lib/app_chat_bridge');
const {parseRolloutMessages,pipeRequest}=require('../companion/app-bridge');
function fixture(t,catalog={threads:[{id:'thread',kind:'codex',title:'Test',hostId:'local',status:'idle'}]}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-bridge-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let items=[],calls=[],sent=[],spoken=[],menus=[];
const bridge=createAppChatBridge({filePath:path.join(dir,'state.json'),request:async r=>{calls.push(r);return r.action==='list'?catalog:{turns:[{id:'turn',items}]};},sendText:async(c,x,options)=>{sent.push(x);if(options)menus.push(options);},speak:async(c,x,p)=>spoken.push({text:x,preset:p}),interruptSpeech(){},validPreset:p=>['off','starship-comms'].includes(p),voiceChoices:()=>[{id:'off',label:'Natürlich',description:'Ohne Effekt'},{id:'starship-comms',label:'Funk',description:'Funkprofil'}]});
return {bridge,calls,sent,spoken,menus,setItems:x=>items=x};}
test('selection skips old history; new commentary is spoken once with its preset',async t=>{
const f=fixture(t);const old={type:'agentMessage',id:'old',text:'old',phase:'final_answer',complete:true};f.setItems([old]);await f.bridge.command('a','list');await f.bridge.command('a','use 1');
f.setItems([old,{...old,id:'new',text:'progress',phase:'commentary'}]);await f.bridge.poll('a',f.bridge.target('a'));await f.bridge.poll('a',f.bridge.target('a'));
assert.deepEqual(f.spoken,[{text:'progress',preset:'starship-comms'}]);assert.equal(await f.bridge.route('a','followup'),true);assert.equal(f.calls.at(-1).action,'send');assert.equal(f.calls.at(-1).threadId,'thread');
});
test('disconnect during STT rejects captured destination, never falls through to local Codex',async t=>{
const f=fixture(t);await f.bridge.command('a','list');await f.bridge.command('a','use 1');const captured={...f.bridge.target('a')};await f.bridge.command('a','off');assert.equal(await f.bridge.route('a','voice',captured),true);assert.equal(f.calls.filter(x=>x.action==='send').length,0);assert.equal(f.bridge.target('b'),null);
});
test('selected app voice also applies to final answers',async t=>{
 const f=fixture(t);await f.bridge.command('a','list');await f.bridge.command('a','use 1');
 f.setItems(['commentary','final_answer'].map((phase,i)=>({type:'agentMessage',id:String(i),text:phase,phase,complete:true})));
 await f.bridge.poll('a',f.bridge.target('a'));
 assert.deepEqual(f.spoken.map(x=>x.preset),['starship-comms','starship-comms']);
});
test('rollout fallback exposes only complete visible assistant messages',()=>{
const row=(role,phase,text,type='response_item')=>JSON.stringify({type,timestamp:'now',payload:{type:'message',role,phase,content:[{type:'output_text',text}]}})+'\n';
const result=parseRolloutMessages(row('assistant','commentary','progress')+row('developer','commentary','secret')+row('assistant','analysis','hidden')+row('assistant','final_answer','done')+'{"partial":');
assert.deepEqual(result.map(x=>x.text),['progress','done']);
});
test('pipe protocol accepts fragmented frames and reports host errors',async t=>{
const net=require('node:net');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-pipe-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const socket=process.platform==='win32'?`\\\\.\\pipe\\aidolon-test-${path.basename(dir)}`:path.join(dir,'sock');
const server=net.createServer(s=>s.once('data',()=>{const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,result:{ok:true}})),h=Buffer.alloc(4);h.writeUInt32LE(b.length);s.write(h.subarray(0,2));setImmediate(()=>s.end(Buffer.concat([h.subarray(2),b])));}));await new Promise(r=>server.listen(socket,r));t.after(()=>new Promise(r=>server.close(r)));assert.deepEqual(await pipeRequest(socket,'tools/list',{}),{ok:true});
});
test('bot speech adapter passes chunk array and interruption version to the TTS queue',async()=>{
const vm=require('node:vm');const source=fs.readFileSync(path.join(__dirname,'../bot.js'),'utf8');const start=source.indexOf('async function enqueueAppChatSpeech('),end=source.indexOf('async function enqueueTts(',start);let queued;
const c=vm.createContext({splitSpeakableTextIntoVoiceChunks:()=>({chunks:['first','second'],overflowText:''}),enqueueTtsBatch:async(...args)=>{queued=args;return true;}});vm.runInContext(source.slice(start,end),c);assert.equal(await c.enqueueAppChatSpeech('chat','text','starship-comms',7),true);assert.deepEqual(queued[1],['first','second']);assert.equal(queued[3].audioVersion,7);assert.equal(queued[3].ttsPreset,'starship-comms');
});

test('repo grouping follows project order and use numbers match the grouped display',async t=>{
  const thread=(id,projectId,cwd,hostId='local')=>({id,projectId,cwd,hostId,kind:'codex',title:id,status:'idle'});
  const catalog={pinnedThreads:[thread('a','p1','C:\\repo-a')],threads:[thread('b','p2','C:\\repo-b'),thread('c','p1','C:\\repo-a'),thread('a','p1','C:\\repo-a'),thread('free',null,'C:\\Users\\test')],sections:[{itemKeys:['codex:project:p2','codex:project:p1']}]};
  const grouped=groupAppThreads(catalog);assert.deepEqual(grouped.rows.map(x=>x.id),['b','a','c','free']);assert.match(grouped.text,/2\. 📌 a/);assert.match(grouped.text,/Ohne Repository/);
  const f=fixture(t,catalog);await f.bridge.command('a','list');await f.bridge.command('a','use 3');assert.equal(f.bridge.target('a').threadId,'c');
});
test('voice menu has valid buttons; chosen voice is retained and applied to commentary',async t=>{
  const f=fixture(t);await f.bridge.command('a','list');await f.bridge.command('a','use 1');await f.bridge.command('a','voice');
  const buttons=f.menus[0].replyMarkup.inline_keyboard.flat();assert.equal(buttons.length,6);for(const b of buttons)assert(Buffer.byteLength(b.callback_data)<=64);
  await f.bridge.command('a','voice off');assert.equal(f.bridge.target('a').preset,'off');
  f.setItems([{type:'agentMessage',id:'new',text:'hello',phase:'commentary',complete:true}]);await f.bridge.poll('a',f.bridge.target('a'));assert.equal(f.spoken[0].preset,'off');
  await f.bridge.command('a','voice mute');assert.equal(f.bridge.target('a').voice,false);
});
test('resumed chat reads newest owned rollout instead of first filename match',t=>{
  const {localMessages}=require('../companion/app-bridge');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-rollouts-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const id='01a065f0-6013-72f0-9556-eff6c9b9dd3b';
  function write(name,owner,text,mtime){const file=path.join(dir,name);fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:owner}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',id:text,role:'assistant',phase:'commentary',content:[{type:'output_text',text}]}})+'\n');fs.utimesSync(file,mtime,mtime);return file;}
  const original=write(`rollout-${id}.jsonl`,id,'old',1000);
  write(`rollout-${id}_resumed.jsonl`,id,'current',2000);
  write(`rollout-${id}_unrelated.jsonl`,'another-thread','wrong',3000);
  assert.deepEqual(localMessages(id,dir).map(x=>x.text),['current']);
  fs.utimesSync(original,4000,4000);
  assert.deepEqual(localMessages(id,dir).map(x=>x.text),['old']);
});

for(const mode of ['text','voice','both'])test(`output mode ${mode} delivers the selected channels`,async t=>{
  const f=fixture(t);await f.bridge.command('a','list');await f.bridge.command('a','use 1');await f.bridge.command('a',`output ${mode}`);
  const before=f.sent.length;f.setItems([{type:'agentMessage',id:'m',text:'output',phase:'commentary',complete:true}]);await f.bridge.poll('a',f.bridge.target('a'));
  assert.equal(f.sent.length-before,mode==='voice'?0:1);assert.equal(f.spoken.length,mode==='text'?0:1);
  assert.equal(f.bridge.target('a').outputMode,mode);
});
test('voice-only mode falls back to text when synthesis cannot be queued',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-output-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let items=[],sent=[];
  const b=createAppChatBridge({filePath:path.join(dir,'bindings.json'),request:async r=>r.action==='list'?{threads:[{id:'t',kind:'codex',title:'Test'}]}:{turns:[{id:'turn',items}]},sendText:async(c,t)=>sent.push(t),speak:async()=>false,interruptSpeech(){},validPreset:()=>true});
  await b.command('c','list');await b.command('c','use 1');await b.command('c','output voice');items=[{type:'agentMessage',id:'m',text:'Must remain accessible',phase:'final_answer',complete:true}];await b.poll('c',b.target('c'));assert.match(sent.at(-1),/Sprachausgabe nicht verfügbar/);assert.match(sent.at(-1),/Must remain accessible/);const count=sent.length;await b.poll('c',b.target('c'));assert.equal(sent.length,count);
});
