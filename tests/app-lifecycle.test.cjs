const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
test('rename action uses native title setter without unsupported host argument or a new app prompt',async()=>{
 const {appRequest}=require('../companion/app-bridge');let args;
 await appRequest({action:'rename',threadId:'target',hostId:'local',title:'New name'},{contextThreadId:'context',pipePath:'fake'},{request:async(pipe,method,p)=>{args=p;return {success:true,contentItems:[{type:'inputText',text:'{}'}]};}});
 assert.equal(args.tool,'set_thread_title');assert.deepEqual(args.arguments,{threadId:'target',source:'codex',title:'New name'});
 await assert.rejects(appRequest({action:'rename',threadId:'target',title:'  '},{contextThreadId:'context',pipePath:'fake'}),/title/i);
});
test('archive action uses the native setter for the explicit target without sending a prompt',async()=>{
 const {appRequest}=require('../companion/app-bridge');let args;
 const result=await appRequest({action:'archive',threadId:'target',hostId:'local'},{contextThreadId:'context',pipePath:'fake'}, {request:async(pipe,method,p)=>{args=p;return {success:true,contentItems:[{type:'inputText',text:'{"archived":true}'}]};}});
 assert.equal(args.tool,'set_thread_archived');assert.deepEqual(args.arguments,{threadId:'target',hostId:'local',source:'codex',archived:true});assert.equal(result.archived,true);
 await assert.rejects(appRequest({action:'archive'},{contextThreadId:'context',pipePath:'fake'}),/threadId/);
});
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'app-life-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('creation uses native project target and replays confirmed result without creating twice',async t=>{
 const {createAppThread}=require('../companion/app-lifecycle'),root=fixture(t),calls=[];
 const call=async(tool,args)=>{calls.push({tool,args});return tool==='list_projects'?{projects:[{projectId:'p',projectKind:'local',hostId:'local'}]}:{threadId:'new',hostId:'local'};};
 const input={requestId:'01234567-1234-1234-1234-123456789abc',projectId:'p',text:'Do my task'};
 const first=await createAppThread(input,{creationRoot:root},call);assert.equal(first.threadId,'new');
 assert.deepEqual(calls.at(-1).args,{prompt:'Do my task',target:{type:'project',projectId:'p',environment:{type:'local'}}});
 assert.deepEqual(await createAppThread(input,{creationRoot:root},call),first);assert.equal(calls.filter(x=>x.tool==='create_thread').length,1);
 await assert.rejects(createAppThread({...input,text:'different task'},{creationRoot:root},call),/different/);
});
test('projectless creation has no inherited project, model or instructions; uncertain send cannot repeat',async t=>{
 const {createAppThread}=require('../companion/app-lifecycle'),root=fixture(t),calls=[];
 const input={requestId:'11234567-1234-1234-1234-123456789abc',projectId:null,text:'Hello'};
 const call=async(tool,args)=>{calls.push({tool,args});if(tool==='list_projects')return {projects:[]};throw Error('timeout');};
 await assert.rejects(createAppThread(input,{creationRoot:root},call),/timeout/);
 assert.deepEqual(calls.at(-1).args,{prompt:'Hello',target:{type:'projectless'}});
 await assert.rejects(createAppThread(input,{creationRoot:root},call),/unconfirmed/);assert.equal(calls.filter(x=>x.tool==='create_thread').length,1);
});
test('missing project and invalid request cannot create a chat',async t=>{
 const {createAppThread}=require('../companion/app-lifecycle'),calls=[];
 await assert.rejects(createAppThread({requestId:'../../escape',text:'x'},{creationRoot:fixture(t)},async()=>{}),/requestId/);
 await assert.rejects(createAppThread({requestId:'21234567-1234-1234-1234-123456789abc',text:'x',projectId:'gone'},{creationRoot:fixture(t)},async tool=>{calls.push(tool);return {projects:[]};}),/project/);
 assert.deepEqual(calls,['list_projects']);
});
test('presence includes archives and requires a known app context in the same database',t=>{
 const {localThreadPresence}=require('../companion/app-lifecycle'),file=path.join(fixture(t),'state.sqlite'),db=new DatabaseSync(file);
 db.exec("CREATE TABLE threads(id TEXT, archived INTEGER); INSERT INTO threads VALUES('context',0),('archived',1)");db.close();
 const p=localThreadPresence(file,'context');assert.equal(p.complete,true);assert.deepEqual(p.ids,['context','archived']);assert.deepEqual(p.archivedIds,['archived']);
 assert.throws(()=>localThreadPresence(file,'other'),/context/);
});
