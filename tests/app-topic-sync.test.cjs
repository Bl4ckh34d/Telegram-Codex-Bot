const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAppChatBridge}=require('../lib/app_chat_bridge');
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-sync-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let rows=[],created=[],edited=[],sent=[],calls=[];
 const options={filePath:path.join(dir,'bindings.json'),autoTopicGroup:'-100',request:async r=>{calls.push(r);return r.action==='list'?{threads:rows}: {turns:[{id:'turn',items:[{type:'agentMessage',id:'old',text:'history',complete:true}]}]};},
 createTopic:async(c,n,o)=>{created.push({n,o});return `-100~${created.length}`;},editTopic:async(c,n)=>edited.push({c,n}),sendText:async(c,s)=>sent.push(s),speak:async()=>{},interruptSpeech(){},validPreset:()=>true};
 return {options,bridge:createAppChatBridge(options),created,edited,sent,calls,setRows:r=>rows=r};
}
test('automatic topics retain host identity, baseline history, survive restarts, and rename in place',async t=>{
 const f=setup(t);const row={id:'same',kind:'codex',title:'Work',hostId:'local'};
 f.setRows([{...row,companionId:'desktop',companionIcon:'🖥️'},{...row,companionId:'laptop',companionIcon:'💻'}]);
 await f.bridge.syncTopics();assert.equal(f.created.length,2);assert.match(f.created[0].n,/🖥️/);assert.match(f.created[1].n,/💻/);
 await f.bridge.poll('-100~1',f.bridge.target('-100~1'));assert.equal(f.sent.length,0);
 const restarted=createAppChatBridge(f.options);await restarted.syncTopics();assert.equal(f.created.length,2);
 f.setRows([{...row,title:'Renamed',companionId:'desktop',companionIcon:'🖥️'}]);await restarted.syncTopics();assert.equal(f.created.length,2);assert.match(f.edited[0].n,/Renamed/);
 await restarted.route('-100~2','Hello laptop');assert.equal(f.calls.at(-1).companionId,'laptop');
});
test('overlapping discovery never creates duplicate topics and per-row failures do not block later rows',async t=>{
 const f=setup(t);f.setRows([{id:'bad',kind:'codex'},{id:'good',kind:'codex'}]);
 const request=f.options.request;f.options.request=r=>r.threadId==='bad'?Promise.reject(new Error('unavailable')):request(r);
 const b=createAppChatBridge(f.options);await Promise.all([b.syncTopics(),b.syncTopics()]);assert.equal(f.created.length,1);assert.equal(b.target('-100~1').threadId,'good');
});
test('disconnect suppresses automatic recreation until explicitly rebound',async t=>{
 const f=setup(t);f.setRows([{id:'t',kind:'codex'}]);await f.bridge.syncTopics();await f.bridge.command('-100~1','off');await createAppChatBridge(f.options).syncTopics();assert.equal(f.created.length,1);
});
test('failed app sends stay handled and are never retried or passed to CLI',async t=>{
 const f=setup(t);f.setRows([{id:'t',kind:'codex'}]);await f.bridge.syncTopics();const b=createAppChatBridge({...f.options,request:async()=>{throw new Error('offline')}});
 assert.equal(await b.route('-100~1','hello'),true);assert.match(f.sent.at(-1),/Nicht automatisch/);
});
test('uncertain topic creation is persisted and never repeated automatically',async t=>{
 const f=setup(t);f.setRows([{id:'t',kind:'codex'}]);let attempts=0;
 const options={...f.options,createTopic:async()=>{attempts++;throw new Error('network timeout');}};
 await createAppChatBridge(options).syncTopics();await createAppChatBridge(options).syncTopics();assert.equal(attempts,1);
});
test('explicit API rejection permits retry while rate limits pause the creation backlog',async t=>{
 const f=setup(t);f.setRows([{id:'one',kind:'codex'},{id:'two',kind:'codex'}]);let attempts=0;
 const options={...f.options,createTopic:async()=>{attempts++;const e=new Error('rate limit');e.retryAfter=60;e.deliveryRejected=true;throw e;}};
 const b=createAppChatBridge(options);await b.syncTopics();await b.syncTopics();assert.equal(attempts,1);
});
test('bindings absent from discovery do not repoll continuously',async t=>{
 const f=setup(t);f.setRows([{id:'t',kind:'codex'}]);await f.bridge.syncTopics();
 const b=createAppChatBridge(f.options);const before=f.calls.length;await b.pollAll();await b.pollAll();assert.equal(f.calls.length-before,1);
});
test('an offline laptop does not block desktop reply polling',async t=>{
 const f=setup(t);f.setRows([{id:'a',kind:'codex',companionId:'laptop'},{id:'b',kind:'codex',companionId:'laptop'},{id:'c',kind:'codex',companionId:'desktop'}]);await f.bridge.syncTopics();await f.bridge.syncTopics();
 const release=[],read=[];const b=createAppChatBridge({...f.options,request:async r=>{read.push(r.companionId);if(r.companionId==='laptop')await new Promise(resolve=>release.push(resolve));return {turns:[]};}});
 const polling=b.pollAll();await new Promise(setImmediate);assert(read.includes('desktop'));release.forEach(resolve=>resolve());await polling;
});
test('manual bulk command shares the paced automatic backlog',async t=>{
 const f=setup(t);f.setRows(Array.from({length:5},(_,i)=>({id:String(i),kind:'codex'})));
 await f.bridge.command('-100','topics');assert.equal(f.created.length,2);assert.match(f.sent.at(-1),/Abgleich/);
 await f.bridge.syncTopics();assert.equal(f.created.length,4);
});
