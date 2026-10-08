const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { detectTtsLanguage, resolveTtsModel, createSerialTtsRequests } = require('../lib/tts_language');
test('startup prewarms the configured default language model',async()=>{
 const source=fs.readFileSync(require.resolve('../bot.js'),'utf8');const start=source.indexOf('async function prewarmAudioKeepalives('),end=source.indexOf('async function runWhisperJob(',start);let loaded;
 const c=vm.createContext({WHISPER_ENABLED:false,TTS_ENABLED:true,TTS_PREWARM_ON_STARTUP:true,TTS_MODEL:'base',TTS_MODEL_DE:'german',TTS_DEFAULT_LANGUAGE:'de',TTS_REFERENCE_AUDIO:'voice.wav',AIDOLON_TTS_SERVER_SCRIPT_PATH:'worker.py',resolveTtsPythonBin:()=> 'python',fs:{existsSync:()=>true},resolveTtsModel,ensureTtsKeepaliveRunning:async(p,m)=>{loaded=m;},ttsKeepalive:{proc:{},ready:true},log(){},redactError:x=>x});
 c.ttsResourcePolicy={available:()=>true};
 vm.runInContext(source.slice(start,end),c);await c.prewarmAudioKeepalives();assert.equal(loaded,'german');
 loaded=null;c.ttsResourcePolicy.available=()=>false;await c.prewarmAudioKeepalives();assert.equal(loaded,null);
});

test('routes German, English and Chinese without treating code or URLs as language', () => {
  for (const [text, expected] of [
    ['Hallo Daniel, die deutsche Stimme ist jetzt bereit.', 'de'],
    ['Die Datei wurde gespeichert.', 'de'],
    ['The file has been saved. You can continue now.', 'en'],
    ['你好，今天的天氣很好。', 'zh'],
    ['Die Ausgabe ist fertig. ```the and for with``` https://example.com/the/and', 'de'],
    ['Okay', 'de'],
  ]) assert.equal(detectTtsLanguage(text, 'de'), expected);
  assert.equal(resolveTtsModel('Guten Morgen!', {baseModel:'base',germanModel:'german'}), 'german');
  assert.equal(resolveTtsModel('Guten Morgen!', {baseModel:'base'}), 'base');
});

test('serializes synthesis across model changes and recovers after failed requests', async () => {
  const serial = createSerialTtsRequests();
  let release;
  const blocked = new Promise(r => { release = r; });
  const calls = [];
  const first = serial(async () => { calls.push('de'); await blocked; throw new Error('failed'); });
  const rejected = assert.rejects(first, /failed/);
  const second = serial(() => { calls.push('en'); return 2; });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['de']);
  release();
  await rejected;
  assert.equal(await second, 2);
  assert.deepEqual(calls, ['de', 'en']);
});

test('transition from a single model waits for exit and prewarms both models with the configured reference', async () => {
  const source = fs.readFileSync(require.resolve('../bot.js'), 'utf8');
  const start = source.indexOf('async function ensureTtsKeepaliveRunning(');
  const end = source.indexOf('function requestTtsKeepalive(', start);
  const old = new EventEmitter();
  const state = {proc:old, ready:true, model:'base'};
  let stopped = false;
  let args;
  const context = vm.createContext({
    ttsKeepalive:state, TTS_MODEL:'base', TTS_MODEL_DE:'german', TTS_KEEP_MODELS_LOADED:true, TTS_REFERENCE_AUDIO:'english-sample.wav',
    TTS_SAMPLE_RATE:48000, TTS_KEEPALIVE_STARTUP_TIMEOUT_MS:0, TTS_IDLE_UNLOAD_MS:60000,
    ttsResourcePolicy:{available:()=>true},
    AIDOLON_TTS_SERVER_SCRIPT_PATH:'worker.py', ROOT:'/tmp', process,
    fs:{existsSync:()=>true}, setTimeout, clearTimeout, log(){},
    clearTtsKeepaliveRestartTimer(){},
    stopTtsKeepalive(){stopped=true; state.proc=null;state.ready=false;},
    spawn(bin, passed){
      args=passed;
      const child=new EventEmitter();child.stdin=new EventEmitter();
      child.stdout=new EventEmitter();child.stderr=new EventEmitter();
      setImmediate(()=>{state.ready=true;state.startResolve(child);state.startPromise=null;});
      return child;
    },
  });
  vm.runInContext(source.slice(start,end), context);
  const pending=context.ensureTtsKeepaliveRunning('python','german');
  await new Promise(setImmediate);
  assert.equal(stopped,true);
  assert.equal(args,undefined, 'no model loaded before previous worker exits');
  old.emit('close',0);
  const worker=await pending;
  assert.equal(args[args.indexOf('--model')+1],'german');
  assert.equal(args[args.indexOf('--resident-model')+1],'base');
  assert.equal(args[args.indexOf('--reference-audio')+1],'english-sample.wav');
  assert.ok(args.includes('--lazy-models'));
  // Late events from a replaced worker must not stop its successor.
  state.proc={};
  worker.emit('close',1);
  assert.notEqual(state.proc,null);
});

test('switches between ready resident language models without terminating the worker', async () => {
  const source=fs.readFileSync(require.resolve('../bot.js'),'utf8');
  const start=source.indexOf('async function ensureTtsKeepaliveRunning(');
  const end=source.indexOf('function requestTtsKeepalive(',start);
  const worker={};
  const state={proc:worker,ready:true,model:'german',residentModels:['german','base']};
  const context=vm.createContext({ttsKeepalive:state,TTS_MODEL:'base',TTS_MODEL_DE:'german',
    ttsResourcePolicy:{available:()=>true},
    TTS_KEEP_MODELS_LOADED:true,fs:{existsSync:()=>true},AIDOLON_TTS_SERVER_SCRIPT_PATH:'worker.py',
    clearTtsKeepaliveRestartTimer(){},log(){},
    stopTtsKeepalive(){assert.fail('resident switch must not stop synthesis worker');},
  });
  vm.runInContext(source.slice(start,end),context);
  assert.equal(await context.ensureTtsKeepaliveRunning('python','base'),worker);
  assert.equal(await context.ensureTtsKeepaliveRunning('python','german'),worker);
});

test('synthesis request tells the resident worker which language model to use', async () => {
  const source=fs.readFileSync(require.resolve('../bot.js'),'utf8');
  const start=source.indexOf('async function requestTtsKeepaliveSerial(');
  const end=source.indexOf('\nasync function ',start+20);
  const state={requestSeq:1};let wire;
  const context=vm.createContext({ttsKeepalive:state,TTS_MODEL:'base',TTS_MODEL_DE:'german',TTS_DEFAULT_LANGUAGE:'de',
    resolveTtsModel,resolveTtsPythonBin:()=> 'python',ensureTtsKeepaliveRunning:async()=>({}),
    writeChildStdin(proc,line){wire=JSON.parse(line);state.pending.resolve({ok:true});return true;},
  });
  vm.runInContext(source.slice(start,end),context);
  await context.requestTtsKeepaliveSerial({type:'synthesize',text:'The file is ready.'});
  assert.equal(wire.model,'base');
});

test('cancellation waits for GPU release, but an already closed worker never blocks recovery', async () => {
  const source = fs.readFileSync(require.resolve('../bot.js'), 'utf8');
  const start = source.indexOf('function stopTtsKeepalive(');
  const end = source.indexOf('function handleTtsKeepaliveLine(', start);
  const state = {proc:new EventEmitter()};
  const context = vm.createContext({ttsKeepalive:state,setTimeout,clearTimeout,
    clearTtsKeepaliveRestartTimer(){},rejectTtsKeepalivePending(){},
    terminateChildTree(){}, scheduleTtsKeepaliveRestart(){},
  });
  vm.runInContext(source.slice(start,end),context);
  const worker=state.proc;
  context.stopTtsKeepalive('cancel',{allowAutoRestart:false});
  assert.ok(state.stopping);
  const closing=state.stopping;
  worker.emit('close');
  await closing;
  assert.equal(state.stopping,null);
  state.proc=Object.assign(new EventEmitter(),{_ttsClosed:true});
  context.stopTtsKeepalive('crash');
  assert.equal(state.stopping,null);
});
