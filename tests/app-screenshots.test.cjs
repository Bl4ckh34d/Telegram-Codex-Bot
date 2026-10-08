const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createAppChatBridge}=require('../lib/app_chat_bridge');
const {createAppScreenshotSender}=require('../lib/companion_screenshot');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-shots-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('each new intermediate message captures once; final answers and disabled screenshots do not',async t=>{
 const dir=fixture(t);let items=[];const shots=[];
 const bridge=createAppChatBridge({filePath:path.join(dir,'bindings.json'),
  request:async input=>input.action==='list'?{threads:[{id:'thread',kind:'codex',title:'Test',companionId:'windows'}]}:{turns:[{id:'turn',items}]},
  sendText:async()=>{},speak:async()=>true,interruptSpeech(){},validPreset:()=>true,
  sendScreenshot:async(chat,binding,current)=>{assert.ok(current());shots.push(binding.companionId);},
 });
 await bridge.command('chat','list');await bridge.command('chat','use 1');
 assert.equal(bridge.target('chat').screenshots,false);await bridge.command('chat','screenshots on');
 const message=(id,phase)=>({id,type:'agentMessage',text:'Update',phase,complete:true});
 items=[message('a','commentary'),message('b','final_answer')];
 await bridge.poll('chat',bridge.target('chat'));await bridge.poll('chat',bridge.target('chat'));
 assert.deepEqual(shots,['windows']);
 await bridge.command('chat','screenshots off');items.push(message('c','commentary'));
 await bridge.poll('chat',bridge.target('chat'));assert.equal(shots.length,1);
});
test('a screenshot failure does not replay the already delivered text',async t=>{
 const dir=fixture(t),sent=[];let items=[];
 const bridge=createAppChatBridge({filePath:path.join(dir,'bindings.json'),
  request:async input=>input.action==='list'?{threads:[{id:'t',kind:'codex'}]}:{turns:[{id:'turn',items}]},
  sendText:async(_,text)=>sent.push(text),speak:async()=>true,interruptSpeech(){},validPreset:()=>true,
  sendScreenshot:async()=>{throw Error('offline');},
 });
 await bridge.command('c','list');await bridge.command('c','use 1');await bridge.command('c','screenshots on');sent.length=0;
 items=[{id:'msg',type:'agentMessage',text:'Unique update',phase:'commentary',complete:true}];
 await bridge.poll('c',bridge.target('c'));await bridge.poll('c',bridge.target('c'));
 assert.equal(sent.filter(s=>s.includes('Unique update')).length,1);
 assert.equal(sent.filter(s=>s.includes('Screenshot nicht verfügbar')).length,1);
});
test('screenshot sender targets the bound host, discards stale captures and cleans temporary files',async t=>{
 const dir=fixture(t);let current=true;const calls=[];
 const png=Buffer.from([137,80,78,71,13,10,26,10]).toString('base64');
 const send=createAppScreenshotSender({outDir:dir,
  request:async input=>{calls.push(input);return {status:'completed',image:png};},
  sendPhoto:async(chat,file)=>{assert.ok(fs.existsSync(file));calls.push({chat});},
 });
 await send('c',{companionId:'linux'},()=>current);
 assert.deepEqual(calls[0],{action:'screenshot',companionId:'linux'});
 assert.equal(fs.readdirSync(dir).length,0);
 current=false;await send('c',{companionId:'windows'},()=>current);
 assert.equal(calls.filter(c=>c.chat).length,1);
});

test('caption carries the update without a repeated host/title header or duplicate text',async t=>{
 const dir=fixture(t),texts=[],captions=[];let items=[];
 const bridge=createAppChatBridge({filePath:path.join(dir,'state.json'),
  request:async r=>r.action==='list'?{threads:[{id:'t',kind:'codex',title:'Title',companionLabel:'Windows'}]}:{turns:[{id:'turn',items}]},
  sendText:async(_,text)=>texts.push(text),speak:async()=>true,interruptSpeech(){},validPreset:()=>true,
  sendScreenshot:async(_,binding,current,options)=>{captions.push(options.text);return {sent:true};},
 });
 await bridge.command('c','list');await bridge.command('c','use 1');await bridge.command('c','screenshots on');texts.length=0;
 items=[{id:'a',type:'agentMessage',text:'Build complete.',phase:'commentary',complete:true}];
 await bridge.poll('c',bridge.target('c'));
 assert.deepEqual(captions,['Build complete.']);assert.deepEqual(texts,[]);
});

test('long captions split without losing text or breaking a surrogate pair',async t=>{
 const dir=fixture(t);let caption;
 const sender=createAppScreenshotSender({outDir:dir,
  request:async()=>({status:'completed',image:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')}),
  sendPhoto:async(_,file,options)=>{caption=options.caption;return {message_id:7};},
 });
 const text='a'.repeat(999)+'😀'+'remaining';
 const result=await sender('c',{},()=>true,{text});
 assert.ok(caption.length<=1000);assert.equal(caption+result.remainder,text);
 assert.equal(result.messageId,7);
});
