const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {conversationKey,routeBody,routeMultipart}=require('../lib/telegram_topics');
const {createAppChatBridge}=require('../lib/app_chat_bridge');
const {createTelegramInbox}=require('../lib/telegram_inbox');
const msg=(thread)=>({chat:{id:-10042,type:'supergroup'},message_thread_id:thread,is_topic_message:true});
test('forum routes distinguish topics, preserve General and ignore ordinary reply threads',()=>{
 assert.equal(conversationKey(msg(20)),'-10042~20');
 assert.equal(conversationKey(msg(21)),'-10042~21');
 assert.equal(conversationKey(msg(1)),'-10042');
 assert.equal(conversationKey({...msg(20),is_topic_message:false}),'-10042');
 for(const method of ['sendMessage','sendPhoto','sendVoice','sendChatAction'])assert.deepEqual(routeBody(method,{chat_id:'-10042~20',text:'x'}),{chat_id:'-10042',message_thread_id:20,text:'x'});
 assert.deepEqual(routeBody('editMessageText',{chat_id:'-10042~20',message_id:8}),{chat_id:'-10042',message_id:8});
 const form=new FormData();form.set('chat_id','-10042~21');routeMultipart('sendVoice',form);
 assert.equal(form.get('chat_id'),'-10042');assert.equal(form.get('message_thread_id'),'21');
});
test('topics retain independent persisted bindings and settings; repeated sync does not recreate them',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'topic-bind-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let next=10,created=0;const calls=[];
 const opts={filePath:path.join(dir,'state.json'),request:async r=>{calls.push(r);return r.action==='list'?{threads:['a','b'].map(id=>({kind:'codex',id,title:id,hostId:'local',companionId:'win',cwd:'C:\\repo'}))}:{turns:[{id:'old',items:[{id:'old',type:'agentMessage'}]}]};},createTopic:async()=>{created++;return `-10042~${next++}`;},sendText:async()=>{},speak:async()=>{},interruptSpeech(){},validPreset:()=>true};
 const b=createAppChatBridge(opts);await b.command('-10042','topics');assert.equal(created,2);assert.equal(b.target('-10042'),null);
 await b.command('-10042~10','voice hologram-ai');await b.command('-10042~10','output text');
 assert.equal(b.target('-10042~11').preset,'starship-comms');assert.equal(b.target('-10042~11').outputMode,'auto');
 await b.command('-10042~11','topics');assert.equal(created,2);
 const restored=createAppChatBridge(opts);assert.equal(restored.target('-10042~10').preset,'hologram-ai');
 await restored.route('-10042~11','hello');assert.equal(calls.at(-1).threadId,'b');assert.equal(calls.at(-1).companionId,'win');
 assert.deepEqual(restored.target('-10042~10').seen,['old:old']);
});
test('inbox recovery cannot dismiss an interrupted message from a sibling topic',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'topic-inbox-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const filePath=path.join(dir,'inbox.json');fs.writeFileSync(filePath,JSON.stringify({'5':{status:'interrupted',update:{update_id:5,message:msg(20)}}}));
 const inbox=createTelegramInbox({filePath,handle:async()=>{},onError:async()=>{}});
 assert.equal(inbox.pending('-10042~21').length,0);assert.equal(inbox.pending('-10042~20').length,1);
 assert.equal(inbox.dismiss('5','-10042~21'),false);assert.equal(inbox.dismiss('5','-10042~20'),true);
});
test('migration silences private forwarding and transfers its voice settings to the topic',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'topic-migrate-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const filePath=path.join(dir,'state.json');fs.writeFileSync(filePath,JSON.stringify({'42':{threadId:'a',hostId:'local',preset:'alien-terminal',outputMode:'voice',outputModeVersion:1,voice:true,seen:[]}}));
 let reads=0;
 const b=createAppChatBridge({filePath,migrateFromChat:'42',request:async r=>{if(r.action==='list')return {threads:[{kind:'codex',id:'a',hostId:'local',companionId:'win'}]};reads++;return {turns:[]};},createTopic:async()=>'-10042~20',sendText:async()=>{},speak:async()=>{},interruptSpeech(){},validPreset:()=>true});
 await b.poll('42',b.target('42'));assert.equal(reads,0);
 await b.command('-10042','topics');assert.equal(b.target('42'),null);assert.equal(b.target('-10042'),null);
 assert.equal(b.target('-10042~20').preset,'alien-terminal');assert.equal(b.target('-10042~20').outputMode,'voice');
});
test('old bindings migrate once to automatic replies; later explicit preferences survive restart',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'topic-mode-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const filePath=path.join(dir,'state.json');
 fs.writeFileSync(filePath,JSON.stringify({'-10042~20':{threadId:'a',outputMode:'both',seen:[]}}));
 const options={filePath,request:async()=>({turns:[]}),sendText:async()=>{},speak:async()=>{},interruptSpeech(){},validPreset:()=>true};
 const b=createAppChatBridge(options);assert.equal(b.target('-10042~20').outputMode,'auto');await b.command('-10042~20','output voice');
 assert.equal(createAppChatBridge(options).target('-10042~20').outputMode,'voice');
});
test('poll failures are debounced and recovery clears persisted error without notification spam',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'topic-error-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const filePath=path.join(dir,'state.json');
 fs.writeFileSync(filePath,JSON.stringify({'-10042~20':{threadId:'a',seen:[]}}));let fail=true;const sent=[];
 const b=createAppChatBridge({filePath,request:async()=>{if(fail)throw new Error('temporary');return {turns:[]};},sendText:async(c,x)=>sent.push(x),speak:async()=>{},interruptSpeech(){},validPreset:()=>true});
 const binding=b.target('-10042~20');
 for(let i=0;i<2;i++)await b.poll('-10042~20',binding);assert.equal(sent.length,0);
 await b.poll('-10042~20',binding);assert.equal(sent.length,1);
 fail=false;await b.poll('-10042~20',binding);assert.equal(JSON.parse(fs.readFileSync(filePath))['-10042~20'].lastError,'');
 fail=true;for(let i=0;i<4;i++)await b.poll('-10042~20',binding);assert.equal(sent.length,1);
});
