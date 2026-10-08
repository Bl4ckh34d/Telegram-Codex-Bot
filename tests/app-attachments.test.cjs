const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {appRequest}=require('../companion/app-bridge');
const {createAppAttachmentHandler}=require('../lib/app_attachment_input');
const {createAppChatBridge}=require('../lib/app_chat_bridge');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=','base64');
function envelope(data=png,name='Bild.png'){return {name,dataBase64:data.toString('base64'),sha256:crypto.createHash('sha256').update(data).digest('hex')};}
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'app-files-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

for(const kind of ['photo','document'])test(`Telegram ${kind} reaches native app send with original bytes, caption and selected thread`,async t=>{
 const root=fixture(t),file=path.join(root,'bindings.json');
 fs.writeFileSync(file,JSON.stringify({chat:{bindingId:'binding',threadId:'selected',hostId:'local',outputModeVersion:1}}));
 let nativeSend;
 const bridge=createAppChatBridge({filePath:file,sendText:async()=>{},interruptSpeech(){},
   request:input=>appRequest(input,{contextThreadId:'context',pipePath:'test',attachmentRoot:path.join(root,'target')},{request:async(p,m,args)=>{nativeSend=args.arguments;return {success:true,contentItems:[]};}})});
 const bytes=kind==='photo'?png:Buffer.from('Attached document: Grüße 中文');
 const handler=createAppAttachmentHandler({stagingRoot:path.join(root,'download'),routeKey:()=> 'chat',getBridge:()=>bridge,
   getFile:async()=>({file_path:'file'}),download:async(p,f)=>fs.writeFileSync(f,bytes),sendText:async()=>assert.fail('download failed')});
 await handler({message_id:42,caption:'Bitte prüfe diesen Anhang.',...(kind==='photo'?{photo:[{file_id:'photo',width:1,height:1}]}:{document:{file_id:'doc',file_name:'notiz.txt'}})});
 assert.equal(nativeSend.threadId,'selected');assert.match(nativeSend.prompt,/Bitte prüfe diesen Anhang\./);
 const manifest=JSON.parse(nativeSend.prompt.split('\n').find(x=>x.startsWith('{"path":')));
 assert.deepEqual(fs.readFileSync(manifest.path),bytes);assert.deepEqual(fs.readdirSync(path.join(root,'download')),[]);
});
test('file bytes are staged on the target host and sent to the same app thread with caption',async t=>{
 const root=fixture(t);let sent;
 await appRequest({action:'send',threadId:'target',hostId:'local',text:'Was zeigt das Bild?',deliveryId:'telegram-1',attachments:[envelope()]},{contextThreadId:'context',pipePath:'test',attachmentRoot:root},{request:async(p,m,args)=>{sent=args;return {success:true,contentItems:[{type:'inputText',text:'{}'}]};}});
 assert.equal(sent.arguments.threadId,'target');assert.match(sent.arguments.prompt,/Was zeigt das Bild/);assert.match(sent.arguments.prompt,/view_image/);
 const line=sent.arguments.prompt.split('\n').find(x=>x.startsWith('{"path":'));
 assert.ok(line,'attachment manifest must be in prompt');const item=JSON.parse(line);
 assert.ok(item.path.startsWith(root+path.sep));assert.deepEqual(fs.readFileSync(item.path),png);assert.equal(item.name,'Bild.png');
});
test('duplicate or uncertain delivery never submits another app turn',async t=>{
 const root=fixture(t);let calls=0;const config={contextThreadId:'c',pipePath:'test',attachmentRoot:root};
 const input={action:'send',threadId:'target',text:'Datei',deliveryId:'same',attachments:[envelope()]};
 const deps={request:async()=>{calls++;throw new Error('delivery unknown');}};
 await assert.rejects(appRequest(input,config,deps),/unknown/);
 await assert.rejects(appRequest(input,config,deps),/bereits|unbestätigt/);assert.equal(calls,1);
});
test('invalid checksum and remote app host are rejected before sending',async t=>{
 const root=fixture(t);let calls=0;const config={contextThreadId:'c',pipePath:'test',attachmentRoot:root};const deps={request:async()=>{calls++;return {success:true,contentItems:[]};}};
 await assert.rejects(appRequest({action:'send',threadId:'t',text:'x',deliveryId:'bad',attachments:[{...envelope(),sha256:'0'.repeat(64)}]},config,deps),/checksum|Prüfsumme/i);
 await assert.rejects(appRequest({action:'send',threadId:'t',hostId:'another-host',text:'x',deliveryId:'remote',attachments:[envelope()]},config,deps),/local|lokal/);assert.equal(calls,0);
});
test('document filenames cannot escape staging and document-only input is supported',async t=>{
 const root=fixture(t);let prompt;
 await appRequest({action:'send',threadId:'t',text:'',deliveryId:'doc',attachments:[envelope(Buffer.from('Dokumentinhalt'),'../../CON.txt')]},{contextThreadId:'c',pipePath:'test',attachmentRoot:root},{request:async(p,m,args)=>{prompt=args.arguments.prompt;return {success:true,contentItems:[]};}});
 const item=JSON.parse(prompt.split('\n').find(x=>x.startsWith('{"path":')));assert.equal(fs.readFileSync(item.path,'utf8'),'Dokumentinhalt');assert.ok(item.path.startsWith(root+path.sep));assert.doesNotMatch(path.basename(item.path),/^CON\./i);
});
test('large valid payload below the download limit is accepted',async t=>{
 const root=fixture(t),bytes=Buffer.alloc(20*1024*1024,37);
 await appRequest({action:'send',threadId:'t',text:'file',deliveryId:'large',attachments:[envelope(bytes,'data.bin')]},{contextThreadId:'c',pipePath:'test',attachmentRoot:root},{request:async()=>({success:true,contentItems:[]})});
});
test('Telegram photo uses largest resolution, preserves caption and cleans download staging',async t=>{
 const root=fixture(t),calls=[],binding={bindingId:'b',threadId:'t'};
 const handler=createAppAttachmentHandler({stagingRoot:root,routeKey:()=>'-1~2',getBridge:()=>({target:()=>binding,route:async(...args)=>calls.push(args)}),getFile:async id=>{assert.equal(id,'large');return {file_path:'photo.jpg'};},download:async(p,f,options)=>{assert.equal(options.maxBytes,20*1024*1024);fs.writeFileSync(f,png);},sendText:async()=>assert.fail('unexpected error')});
 await handler({message_id:1,caption:'Frage mit Umlauten: Größe?',photo:[{file_id:'small',width:10,height:10},{file_id:'large',width:100,height:100}]});
 assert.equal(calls[0][0],'-1~2');assert.equal(calls[0][1],'Frage mit Umlauten: Größe?');assert.deepEqual(Buffer.from(calls[0][3].attachments[0].dataBase64,'base64'),png);assert.deepEqual(fs.readdirSync(root),[]);
});
test('rebinding during download does not leak the file into the new app chat',async t=>{
 const root=fixture(t),file=path.join(root,'bindings.json');fs.writeFileSync(file,JSON.stringify({'chat':{bindingId:'old',threadId:'old',outputModeVersion:1}}));let sends=0;const notices=[];
 const bridge=createAppChatBridge({filePath:file,request:async()=>{sends++;},sendText:async(c,x)=>notices.push(x),speak:async()=>{},interruptSpeech(){},validPreset:()=>true});
 const handler=createAppAttachmentHandler({stagingRoot:path.join(root,'download'),routeKey:()=> 'chat',getBridge:()=>bridge,getFile:async()=>({file_path:'x'}),download:async(p,f)=>{fs.writeFileSync(f,png);bridge.target('chat').bindingId='new';},sendText:async(c,x)=>notices.push(x)});
 await handler({message_id:1,document:{file_id:'f',file_name:'x.png'}});assert.equal(sends,0);assert.match(notices[0],/geändert/);
});
test('declared and actual oversize files never route to app',async t=>{
 const root=fixture(t),notices=[];let sends=0,downloads=0;
 const handler=createAppAttachmentHandler({stagingRoot:root,routeKey:()=> 'chat',getBridge:()=>({target:()=>({bindingId:'b'}),route:async()=>sends++}),getFile:async()=>({file_path:'x'}),download:async(p,f)=>{downloads++;const fd=fs.openSync(f,'w');fs.ftruncateSync(fd,20*1024*1024+1);fs.closeSync(fd);},sendText:async(c,x)=>notices.push(x)});
 await handler({message_id:1,document:{file_id:'f',file_size:20*1024*1024+1}});
 await handler({message_id:2,document:{file_id:'f',file_size:1}});
 assert.equal(downloads,1);assert.equal(sends,0);assert.equal(notices.length,2);assert.deepEqual(fs.readdirSync(root),[]);
});
