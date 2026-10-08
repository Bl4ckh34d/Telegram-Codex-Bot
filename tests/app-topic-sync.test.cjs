const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAppChatBridge}=require('../lib/app_chat_bridge');
test('pause during screenshot delivery never drops a voice-only app reply',async t=>{
 const f=setup(t);f.setRows([{id:'t',kind:'codex'}]);await f.bridge.syncTopics();let available=true;
 const bridge=createAppChatBridge({...f.options,speechAvailable:()=>available,
   sendScreenshot:async()=>{available=false;return {sent:true};},speak:async()=>assert.fail('paused'),
   request:async()=>({turns:[{id:'new',items:[{type:'agentMessage',id:'reply',text:'Antwort bleibt sichtbar',phase:'commentary',complete:true}]}]})});
 const binding=bridge.target('-100~1');binding.outputMode='voice';binding.screenshots=true;
 await bridge.poll('-100~1',binding);assert.deepEqual(f.sent,['Antwort bleibt sichtbar']);assert.ok(binding.seen.includes('new:reply'));
});
test('paused TTS delivers a voice-mode app response as clean text without changing the saved preference',async t=>{
 const f=setup(t);f.setRows([{id:'t',kind:'codex'}]);await f.bridge.syncTopics();
 const bridge=createAppChatBridge({...f.options,speechAvailable:()=>false,speak:async()=>assert.fail('must not synthesize'),request:async()=>({turns:[{id:'new',items:[{type:'agentMessage',id:'reply',text:'Antwort als Text',complete:true}]}]})});
 const binding=bridge.target('-100~1');binding.outputMode='voice';
 await bridge.poll('-100~1',binding);
 assert.deepEqual(f.sent,['Antwort als Text']);assert.equal(binding.outputMode,'voice');
});
test('topic titles strip only the configured device decoration, preserving title punctuation and emojis',()=>{
 const {appTitleFromTopic}=require('../lib/app_chat_bridge');
 assert.equal(appTitleFromTopic('🌐 🖥️ PC · 🚀 Dragon · chase',{companionLabel:'PC'}),'🚀 Dragon · chase');
 assert.equal(appTitleFromTopic('💻 Laptop · Research',{companionLabel:'Laptop'}),'Research');
 assert.equal(appTitleFromTopic('PC · Research',{companionLabel:'PC'}),'Research');
 assert.equal(appTitleFromTopic('🚀 Research · notes',{companionLabel:'PC'}),'🚀 Research · notes');
 assert.throws(()=>appTitleFromTopic('🖥️ PC · ',{companionLabel:'PC'}),/empty/i);
});
test('topic rename persists offline, wins over stale discovery, and resumes normal app-to-topic sync',async t=>{
 const f=setup(t);const row={id:'t',kind:'codex',title:'Old',companionId:'desktop',companionLabel:'PC',companionIcon:'🖥️',hostId:'local'};f.setRows([row]);await f.bridge.syncTopics();
 let online=false,now=100000;const renames=[];
 const request=async r=>{if(r.action==='rename'){renames.push(r);if(!online)throw Error('offline');return {title:r.title};}return r.action==='list'?{threads:[row]}:{turns:[]};};
 const options={...f.options,request,now:()=>now};let b=createAppChatBridge(options);
 await b.topicRenamed('-100~1','🖥️ PC · New');assert.equal(b.target('-100~1').renamePending,'New');await b.syncTopics();assert.equal(f.edited.length,0);
 b=createAppChatBridge(options);online=true;now+=31000;await b.syncTopics();assert.equal(renames.at(-1).title,'New');assert.equal(f.edited.length,0);
 row.title='New';await b.syncTopics();row.title='App rename';await b.syncTopics();assert.match(f.edited.at(-1).n,/App rename$/);
});
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
test('background reads stay silent while a laptop is offline and resume replies after recovery',async t=>{
 const f=setup(t);f.setRows([{id:'t',kind:'codex',companionId:'laptop'}]);await f.bridge.syncTopics();
 let online=false,reads=0;
 const b=createAppChatBridge({...f.options,request:async()=>{reads++;if(!online)throw new Error('Companion-Abfrage fehlgeschlagen (Exit 255).');return {turns:[{id:'turn',items:[{type:'agentMessage',id:'new',text:'Recovered reply',phase:'final_answer',complete:true}]}]};}});
 for(let i=0;i<4;i++)await b.poll('-100~1',b.target('-100~1'));
 assert.equal(reads,4);assert.equal(b.target('-100~1').readFailures,4);assert.match(b.target('-100~1').lastError,/Exit 255/);assert.deepEqual(f.sent,[]);
 online=true;await b.poll('-100~1',b.target('-100~1'));await b.poll('-100~1',b.target('-100~1'));
 assert.deepEqual(f.sent,['Recovered reply']);assert.equal(b.target('-100~1').readFailures,0);assert.equal(b.target('-100~1').lastError,'');
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
test('two complete snapshots delete missing topics but close archived topics; offline devices survive',async t=>{
 const f=setup(t);f.setRows([{id:'gone',kind:'codex',companionId:'desktop',hostId:'local'},{id:'archive',kind:'codex',companionId:'desktop',hostId:'local'},{id:'offline',kind:'codex',companionId:'laptop',hostId:'local'}]);await f.bridge.syncTopics();await f.bridge.syncTopics();
 let now=100000;const deleted=[];let snapshot={threads:[],presence:[{complete:true,companionId:'desktop',hostId:'local',ids:['archive'],archivedIds:['archive']}]};
 const closed=[];const options={...f.options,now:()=>now,deleteTopic:async route=>deleted.push(route),setTopicClosed:async(route,value)=>closed.push({route,value}),request:async()=>snapshot};
 let b=createAppChatBridge(options);await b.syncTopics();assert.equal(deleted.length,0);now+=11000;
 b=createAppChatBridge(options);await b.syncTopics();assert.deepEqual(deleted,['-100~1']);assert.deepEqual(closed,[{route:'-100~2',value:true}]);assert(b.target('-100~2'));assert(b.target('-100~3'));assert.equal(b.target('-100~1'),null);
});
test('archived metadata overrides stale visible rows; unarchive reopens the same topic with history',async t=>{
 const f=setup(t),row={id:'t',kind:'codex',companionId:'desktop',hostId:'local'};f.setRows([row]);await f.bridge.syncTopics();
 let now=100000;const closed=[];let archivedIds=['t'];
 const b=createAppChatBridge({...f.options,now:()=>now,setTopicClosed:async(route,value)=>closed.push(value),deleteTopic:async()=>assert.fail('Archive must not delete'),request:async r=>r.action==='list'?{threads:[row],presence:[{complete:true,companionId:'desktop',hostId:'local',ids:['t'],archivedIds}]}:{turns:[]}});
 const seen=[...b.target('-100~1').seen];await b.syncTopics();now+=11000;await b.syncTopics();await b.syncTopics();assert.deepEqual(closed,[true]);assert.equal(f.created.length,1);
 archivedIds=[];await b.syncTopics();assert.equal(f.created.length,1);assert.deepEqual(closed,[true,false]);assert.deepEqual(b.target('-100~1').seen,seen);
});
test('unarchive, incomplete scans, and other hosts reset archive evidence; failed closing retries',async t=>{
 const f=setup(t);f.setRows([{id:'t',kind:'codex',companionId:'desktop',hostId:'local'}]);await f.bridge.syncTopics();
 let now=100000,attempts=0;const presence={complete:true,companionId:'desktop',hostId:'local',ids:['t'],archivedIds:['t']};
 let snapshot={threads:[],presence:[presence]};
 const b=createAppChatBridge({...f.options,now:()=>now,request:async()=>snapshot,setTopicClosed:async()=>{if(++attempts===1)throw Error('offline');},deleteTopic:async()=>assert.fail('Archive must not delete')});
 await b.syncTopics();presence.archivedIds=[];now+=11000;await b.syncTopics();assert.equal(attempts,0);
 presence.archivedIds=['t'];now+=11000;await b.syncTopics();presence.complete=false;now+=11000;await b.syncTopics();
 presence.complete=true;presence.hostId='remote';now+=11000;await b.syncTopics();assert.equal(attempts,0);
 presence.hostId='local';now+=11000;await b.syncTopics();assert.equal(attempts,0);now+=11000;await b.syncTopics();assert.equal(attempts,1);assert(b.target('-100~1'));
 now+=11000;await b.syncTopics();assert.equal(attempts,2);assert.equal(b.target('-100~1').topicClosed,true);
});
test('definitively missing topics archive the app chat and are never recreated',async t=>{
 const f=setup(t),row={id:'t',kind:'codex',companionId:'desktop',hostId:'local'};f.setRows([row]);await f.bridge.syncTopics();
 const request=f.options.request;const sent=[];
 const b=createAppChatBridge({...f.options,request:async r=>r.action==='read'?{turns:[{id:'turn',items:[{type:'agentMessage',id:'new',text:'pending reply',complete:true}]}]}:request(r),sendText:async(route,text)=>{if(route==='-100~1')throw Error('Telegram sendMessage failed: 400 Bad Request: message thread not found');sent.push(text);}});
 b.target('-100~1').preset='custom';await b.poll('-100~1',b.target('-100~1'));await b.syncTopics();
 assert.equal(f.created.length,1);assert.equal(b.target('-100~1').topicDeleted,true);assert.equal(f.calls.at(-1).action,'archive');assert.equal(f.calls.at(-1).threadId,'t');assert.deepEqual(sent,[]);
});
test('closing a topic persists archive intent while offline and retries after restart without reopening',async t=>{
 const f=setup(t);f.setRows([{id:'t',kind:'codex',companionId:'desktop',hostId:'local'}]);await f.bridge.syncTopics();
 let now=100000,online=false;const archived=[];
 const options={...f.options,now:()=>now,request:async r=>{assert.notEqual(r.action,'send');if(r.action==='archive'){if(!online)throw Error('offline');archived.push(r);return {archived:true};}return {threads:[],presence:[{complete:true,companionId:'desktop',hostId:'local',ids:['t'],archivedIds:[]}]};},setTopicClosed:async()=>assert.fail('must not reopen before archive completes')};
 let b=createAppChatBridge(options);assert.equal(await b.topicLifecycle('-100~1','closed'),true);assert(b.target('-100~1').archivePending);
 b=createAppChatBridge(options);online=true;now+=31000;await b.syncTopics();assert.equal(archived.length,1);assert.equal(b.target('-100~1').topicClosed,true);assert.equal(b.target('-100~1').archivePending,undefined);
 assert.equal(await b.route('-100~1','must stay inactive'),true);assert.equal(archived.length,1);
 assert.equal(f.sent.length,0);
});
test('topic checks detect silent deletions; timeouts do not archive anything',async t=>{
 const f=setup(t);f.setRows([{id:'t',kind:'codex',companionId:'desktop',hostId:'local'}]);await f.bridge.syncTopics();let missing=false,now=100000;
 const b=createAppChatBridge({...f.options,now:()=>now,checkTopic:async()=>{if(!missing)throw Error('timeout');return false;}});
 await b.syncTopics();assert.equal(f.calls.filter(r=>r.action==='archive').length,0);missing=true;now+=310000;await b.syncTopics();
 assert.equal(f.calls.filter(r=>r.action==='archive').length,1);assert.equal(b.target('-100~1').topicDeleted,true);assert.equal(f.created.length,1);
});
test('ambiguous send failures never recreate an existing topic',async t=>{
 const f=setup(t);f.setRows([{id:'t',kind:'codex'}]);await f.bridge.syncTopics();const b=createAppChatBridge({...f.options});
 b.target('-100~1').lastError='Telegram sendMessage failed: network timeout';await b.syncTopics();assert.equal(f.created.length,1);assert(b.target('-100~1'));
});
test('incomplete snapshots reset absence evidence and deletion failure retains binding for retry',async t=>{
 const f=setup(t);f.setRows([{id:'t',kind:'codex',companionId:'desktop',hostId:'local'}]);await f.bridge.syncTopics();
 let now=100000,snapshot={threads:[],presence:[{complete:true,companionId:'desktop',hostId:'local',ids:[],archivedIds:[]}]},attempts=0;
 const full=snapshot;const b=createAppChatBridge({...f.options,now:()=>now,request:async()=>snapshot,deleteTopic:async()=>{attempts++;throw Error('offline');}});
 await b.syncTopics();snapshot={threads:[],errors:['offline']};now+=11000;await b.syncTopics();snapshot=full;now+=11000;await b.syncTopics();assert.equal(attempts,0);now+=11000;await b.syncTopics();assert.equal(attempts,1);assert(b.target('-100~1'));
});
