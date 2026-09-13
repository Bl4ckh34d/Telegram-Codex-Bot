const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const source=fs.readFileSync(require.resolve('../bot.js'),'utf8');
const begin=source.indexOf('function appendTtsStutterLayer(');
const end=source.indexOf('function buildSciFiVoiceComplexSpec(',begin);
const context=vm.createContext({});vm.runInContext(source.slice(begin,end),context);
const filters=new Set(['asplit','atrim','asetpts','afade','aloop','adelay','volume','amix']);
test('stutter falls back cleanly if an optional filter is absent',()=>{
 const parts=[];assert.equal(context.appendTtsStutterLayer(parts,'voice','out',new Set()),'voice');
 assert.deepEqual(parts,[]);
});
test('real micro-loop graph preserves full speech duration, including clips shorter than the first loop',t=>{
 if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('ffmpeg unavailable');return;}
 for(const duration of [0.2,2,5]){
  const parts=['[0:a]aresample=48000[input]'];
  context.appendTtsStutterLayer(parts,'input','out',filters);
  const result=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${duration}`,
    '-filter_complex',parts.join(';'),'-map','[out]','-ac','1','-ar','48000','-f','f32le','pipe:1'],{timeout:10000,maxBuffer:4*1024*1024});
  assert.equal(result.status,0,String(result.stderr));
  assert.ok(Math.abs(result.stdout.length/4/48000-duration)<0.03,'no truncation or looping tail');
 }
});
