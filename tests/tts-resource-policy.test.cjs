const test=require('node:test'),assert=require('node:assert/strict');
const {createTtsResourcePolicy}=require('../lib/tts_resource_policy');
test('local control round trip and validation require no debugger or network port',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {startTtsControl,sendTtsControl}=require('../lib/tts_control');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tts-control-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let paused=false;
 const stop=startTtsControl({directory,command:async action=>{paused=action==='pause';},status:()=>({paused})});t.after(stop);
 assert.equal((await sendTtsControl(directory,'pause')).paused,true);
 assert.equal((await sendTtsControl(directory,'resume')).paused,false);
 await assert.rejects(sendTtsControl(directory,'execute'),/Use pause/);
});
test('host capability instructions reach local app sends only',()=>{
 const {withTtsInstructions}=require('../lib/tts_agent_instructions');
 const input={action:'send',text:'Use ComfyUI',hostId:'local'};
 assert.match(withTtsInstructions(input,'C:/bot').text,/tts-control.cjs.*pause/);
 assert.equal(withTtsInstructions({...input,hostId:'remote'},'C:/bot').text,input.text);
 assert.equal(withTtsInstructions({action:'read'},'C:/bot').text,undefined);
});
test('unloads after one idle minute, extends on voice input, never unloads during synthesis',async()=>{
 let now=0,unloads=0;const p=createTtsResourcePolicy({now:()=>now,idleMs:60000,unload:async()=>unloads++,preload:async()=>{},save(){}});
 p.begin();now=70000;await p.tick();assert.equal(unloads,0);p.end();
 now=120000;p.touch();now=179999;await p.tick();assert.equal(unloads,0);
 now=180000;await p.tick();assert.equal(unloads,1);await p.tick();assert.equal(unloads,1);
});
test('pause is immediate, persists, releases GPU and resume restores automatic speech',async()=>{
 let saved,unloads=0,loads=0;
 const p=createTtsResourcePolicy({idleMs:60000,unload:async()=>unloads++,preload:async()=>loads++,save:s=>saved=s});
 await p.command('pause');assert.equal(p.available(),false);assert.equal(saved.paused,true);assert.equal(unloads,1);
 assert.throws(()=>p.begin(),/paused/);
 await p.command('resume');assert.equal(p.available(),true);assert.equal(saved.paused,false);assert.equal(loads,1);
});
test('queued activity invalidates an idle unload that has not started yet',async()=>{
 let now=0,guard,unloads=0;
 const p=createTtsResourcePolicy({now:()=>now,idleMs:60,preload:async()=>{},save(){},unload:async options=>{guard=options.shouldUnload;}});
 p.begin();p.end();now=60;await p.tick();p.begin();if(guard())unloads++;p.end();assert.equal(unloads,0);
});
