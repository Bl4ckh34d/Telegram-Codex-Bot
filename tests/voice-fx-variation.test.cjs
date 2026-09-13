const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {createVoiceFxVariation}=require('../lib/voice_fx_variation');
test('effect variation is reproducible for retries and bounded across different messages',()=>{
 assert.deepEqual(createVoiceFxVariation('same'),createVoiceFxVariation('same'));
 assert.notDeepEqual(createVoiceFxVariation('a'),createVoiceFxVariation('b'));
 for(let i=0;i<100;i++){
  const v=createVoiceFxVariation(i);
  assert.ok(v.pitch>=0.98&&v.pitch<=1.02);
  assert.ok(v.gain>=0.85&&v.gain<=1.15);
  assert.ok(v.slots.every(s=>s.length>=0.065&&s.length<=0.095));
 }
});
test('every pipelined voice chunk retains the selected effect profile',async()=>{
 const source=fs.readFileSync(require.resolve('../bot.js'),'utf8');
 const a=source.indexOf('async function runTtsBatchJobPipelined('),b=source.indexOf('function shouldUsePipelinedTtsBatch(',a);
 const calls=[];
 const c=vm.createContext({normalizeTtsText:x=>x,resolveTtsRuntime:()=>({ok:true}),log(){},TTS_SEND_TEXT:false,
  runTtsJob:async job=>{calls.push({preset:job.ttsPreset,index:job.ttsChunkIndex,text:job.text});return {ok:true};},
 });
 vm.runInContext(source.slice(a,b),c);
 const job={texts:['first','second','third'],kind:'tts-batch',source:'voice-reply',ttsPreset:'alien-terminal',skipResultText:true};
 const result=await c.runTtsBatchJobPipelined(job,{});
 assert.equal(result.ok,true);
 assert.deepEqual(calls.map(c=>c.preset),['alien-terminal','alien-terminal','alien-terminal']);
 assert.deepEqual(calls.map(c=>c.index),[0,1,2]);
 assert.equal(job.ttsPreset,'alien-terminal');assert.equal(job.kind,'tts-batch');
});
