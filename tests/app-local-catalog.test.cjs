const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
test('complete local catalog includes old visible user chats, excludes agents, exec and archived threads',t=>{
 const {localThreadCatalog}=require('../companion/app-local-catalog');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-catalog-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'state_5.sqlite');
 const db=new DatabaseSync(file);db.exec('CREATE TABLE threads(id TEXT, title TEXT, name TEXT, cwd TEXT, updated_at INTEGER, source TEXT, archived INTEGER, project_id TEXT)');
 const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)');for(let i=0;i<75;i++)insert.run('t'+i,'Title'+i,null,'/repo',i,'vscode',0,'p');
 insert.run('agent','Agent',null,'/repo',100,'{"subagent":{}}',0,null);insert.run('exec','Router',null,'/repo',100,'exec',0,null);insert.run('archived','Archived',null,'/repo',100,'vscode',1,null);db.close();
 const rows=localThreadCatalog(file);assert.equal(rows.length,75);assert.equal(rows[0].id,'t74');assert.equal(rows[0].hostId,'local');
});
test('app request uses current callerSource protocol and all 50 available sidebar rows',async t=>{
 const {appRequest}=require('../companion/app-bridge');let called;
 await appRequest({action:'list'},{contextThreadId:'context',pipePath:'test',includeLocalCatalog:false},{request:async(p,m,args)=>{called=args;return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({threads:[]})}]};}});
 assert.equal(called.callerSource,'codex');assert.equal(called.arguments.limit,50);
});
test('multiple app pipes are identified by a read-only local context probe, never by sending',async t=>{
 const {discoverPipe}=require('../companion/app-bridge');const calls=[];
 const selected=await discoverPipe('context',async(pipe,method,args)=>{calls.push(args);return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({thread:{id:pipe==='correct'?'context':'other',kind:'codex',hostId:'local'}})}]};},['wrong','correct']);
 assert.equal(selected,'correct');assert(calls.every(x=>x.tool==='read_thread'));assert.equal(calls.length,2);
 const cached=await discoverPipe('context',async()=>{throw new Error('must reuse verified pipe');},['wrong','correct']);assert.equal(cached,'correct');
});
