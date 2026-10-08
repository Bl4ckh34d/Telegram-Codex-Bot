const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
function setup(t,overrides={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-new-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const sent=[],calls=[],bound=[];
 const options={filePath:path.join(dir,'create.json'),sendText:async(c,text,opts)=>{sent.push({c,text,opts});return [{message_id:sent.length}];},request:async r=>{calls.push(r);if(r.action==='hosts')return {hosts:[{id:'pc',label:'PC'},{id:'laptop',label:'Laptop'}]};if(r.action==='projects')return {projects:[{projectId:'repo',label:'Repo'}]};return {threadId:'real',hostId:'local',companionId:r.companionId};},bindCreated:async(c,row)=>{bound.push(row);return '-100~42';},...overrides};
 return {options,sent,calls,bound,flow:require('../lib/app_chat_creation').createAppChatCreation(options)};}
const button=(f,row=0)=>f.sent.at(-1).opts.replyMarkup.inline_keyboard[row][0].callback_data;
test('device and projectless selection create once on selected host only after explicit prompt reply',async t=>{
 const f=setup(t);await f.flow.begin('-100','owner');await f.flow.callback('-100','owner',button(f,1));await f.flow.callback('-100','owner',button(f));
 const reply=f.sent.length;assert.equal(await f.flow.text('-100','owner','unrelated',0),false);
 assert.equal(await f.flow.text('-100','owner','My task',reply),true);assert.equal(f.bound.length,1);assert.equal(f.bound[0].threadId,'real');
 const create=f.calls.find(x=>x.action==='create');assert.equal(create.companionId,'laptop');assert.equal(create.projectId,null);
 await f.flow.text('-100','owner','My task',reply);assert.equal(f.calls.filter(x=>x.action==='create').length,1);
});
test('offline device and wrong user clicks cannot create topics',async t=>{
 const f=setup(t);await f.flow.begin('-100','owner');await assert.rejects(f.flow.callback('-100','other',button(f)),/expired|owner/i);assert.equal(f.calls.length,1);
 const request=f.options.request;f.options.request=async r=>{if(r.action==='projects')throw Error('offline');return request(r);};
 const flow=require('../lib/app_chat_creation').createAppChatCreation(f.options);await assert.rejects(flow.callback('-100','owner',button(f)),/offline/);assert.equal(f.bound.length,0);
});
test('uncertain creation remains blocked across restart and never creates a topic',async t=>{
 const f=setup(t);await f.flow.begin('-100','owner');await f.flow.callback('-100','owner',button(f));await f.flow.callback('-100','owner',button(f));const reply=f.sent.length;
 const request=f.options.request;f.options.request=async r=>{if(r.action==='create')throw Error('timeout');return request(r);};
 const flow=require('../lib/app_chat_creation').createAppChatCreation(f.options);await flow.text('-100','owner','Task',reply);assert.equal(f.bound.length,0);
 await assert.rejects(require('../lib/app_chat_creation').createAppChatCreation(f.options).begin('-100','owner'),/unconfirmed/);
});
test('clientThreadId alone never binds a topic',async t=>{
 const f=setup(t),request=f.options.request;f.options.request=async r=>r.action==='create'?{clientThreadId:'pending'}:request(r);f.flow=require('../lib/app_chat_creation').createAppChatCreation(f.options);
 await f.flow.begin('-100','owner');await f.flow.callback('-100','owner',button(f));await f.flow.callback('-100','owner',button(f));await f.flow.text('-100','owner','Task',f.sent.length);assert.equal(f.bound.length,0);assert.match(f.sent.at(-1).text,/pending|unconfirmed/i);
});

test('project pagination and search retain real catalog indexes',async t=>{
 const f=setup(t),request=f.options.request;
 f.options.request=async r=>r.action==='projects'?{projects:Array.from({length:19},(_,i)=>({projectId:`p${i}`,label:`Repo ${i}`}))}:request(r);
 f.flow=require('../lib/app_chat_creation').createAppChatCreation(f.options);
 await f.flow.begin('-100','owner');await f.flow.callback('-100','owner',button(f));
 let keyboard=f.sent.at(-1).opts.replyMarkup.inline_keyboard;
 await f.flow.callback('-100','owner',keyboard.flat().find(b=>b.text==='Next').callback_data);
 keyboard=f.sent.at(-1).opts.replyMarkup.inline_keyboard;assert.equal(keyboard[1][0].text,'Repo 8');
 await f.flow.callback('-100','owner',keyboard.flat().find(b=>b.text==='Search projects').callback_data);
 await f.flow.text('-100','owner','Repo 17',f.sent.length);await f.flow.callback('-100','owner',button(f,1));
 await f.flow.text('-100','owner','Task',f.sent.length);assert.equal(f.calls.find(r=>r.action==='create').projectId,'p17');
});

test('confirmed creation can retry topic binding without creating again',async t=>{
 let fail=true;const f=setup(t,{bindCreated:async()=>{if(fail)throw Error('Telegram unavailable');return '-100~42';}});
 await f.flow.begin('-100','owner');await f.flow.callback('-100','owner',button(f));await f.flow.callback('-100','owner',button(f));
 await f.flow.text('-100','owner','Task',f.sent.length);fail=false;
 await require('../lib/app_chat_creation').createAppChatCreation(f.options).begin('-100','owner');
 assert.equal(f.calls.filter(r=>r.action==='create').length,1);assert.match(f.sent.at(-1).text,/Created/);
});
