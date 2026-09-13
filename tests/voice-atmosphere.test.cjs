const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {addVoiceAtmosphere}=require('../lib/voice_atmosphere');
const names=['asplit','sine','anoisesrc','lowpass','highpass','volume','amix','sidechaincompress','aresample','alimiter'];
const filters=new Set(names);
test('ambience can be disabled and respects natural/custom voices and missing capabilities',()=>{
 const base={mode:'af',graph:'anull',mapLabel:''};
 for(const [preset,set,options] of [['off',filters,{}],['custom',filters,{}],['alien-terminal',new Set(),{}],['alien-terminal',filters,{enabled:false}],['alien-terminal',filters,{level:0}]])
  assert.equal(addVoiceAtmosphere(base,preset,set,options),base);
});
test('generated background ends with the voice rather than running forever',t=>{
 if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('ffmpeg unavailable');return;}
 const config=addVoiceAtmosphere({mode:'af',graph:'anull'},'starship-comms',filters);
 const r=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=0.3',
  '-filter_complex',config.graph,'-map',`[${config.mapLabel}]`,'-ac','1','-ar','48000','-f','f32le','pipe:1'],{timeout:5000,maxBuffer:1024*1024});
 assert.equal(r.status,0,String(r.stderr));
 assert.ok(Math.abs(r.stdout.length/4/48000-0.3)<0.03);
});
test('spaces vary between chunks but reproduce the same seed, independent of language',()=>{
 const capable=new Set([...filters,'aevalsrc','aecho']);const base={mode:'af',graph:'anull'};
 const build=seed=>addVoiceAtmosphere(base,'alien-terminal',capable,{seed}).graph;
 assert.equal(build('chunk-1'),build('chunk-1'));assert.notEqual(build('chunk-1'),build('chunk-2'));
 assert.match(build('chunk-1'),/aevalsrc/);assert.match(build('chunk-1'),/aecho/);
});
test('all spaces produce bounded finite background during speech silence and end on time',t=>{
 if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('ffmpeg unavailable');return;}
 const capable=new Set([...filters,'aevalsrc','aecho']);
 for(const preset of ['hologram-ai','starship-comms','cyber-oracle','alien-terminal','anonymous']) {
  const config=addVoiceAtmosphere({mode:'af',graph:'anull'},preset,capable,{seed:'silence-preview'});
  const r=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','anullsrc=r=48000:cl=mono:d=2',
   '-filter_complex',config.graph,'-map',`[${config.mapLabel}]`,'-ac','1','-ar','48000','-f','f32le','pipe:1'],{timeout:10000,maxBuffer:1024*1024});
  assert.equal(r.status,0,`${preset}: ${r.stderr}`);assert.ok(Math.abs(r.stdout.length/4/48000-2)<0.03);
  let peak=0,sum=0;for(let i=0;i<r.stdout.length;i+=4){const x=r.stdout.readFloatLE(i);assert.ok(Number.isFinite(x));peak=Math.max(peak,Math.abs(x));sum+=x*x;}
  assert.ok(peak<0.12,`${preset}: ambience too loud`);assert.ok(sum/(r.stdout.length/4)>1e-7,`${preset}: no independent background`);
 }
});
