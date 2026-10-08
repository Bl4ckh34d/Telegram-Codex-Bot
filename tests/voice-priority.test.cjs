const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createOrchLaneRuntime } = require('../lib/orch_lane_runtime');

test('direct replies precede queued background voice while preserving FIFO', async () => {
  const lane = { id: 'tts', currentJob: { id: 99 }, queue: [] };
  let sequence = 0;
  const runtime = createOrchLaneRuntime({ ensureTtsLane: () => lane, getLane: () => lane,
    getShuttingDown: () => true, normalizeTtsText: x => x, getActiveWorkerForChat: () => 'general',
    conversationState: { audioVersion: () => 0 }, resolveTtsPresetForChat: () => 'default',
    takeNextJobId: () => ++sequence, jobJournal: { queued() {} }, log() {}, redactError: x => x });
  await runtime.enqueueTtsBatch('news', ['one', 'two'], 'voice-reply', { backgroundVoice: true });
  await runtime.enqueueTts('chat', 'first', 'voice-reply');
  await runtime.enqueueTts('chat', 'second', 'voice-reply');
  assert.deepEqual(lane.queue.map(j => j.chatId), ['chat', 'chat', 'news']);
  assert.equal(lane.queue[2].backgroundVoice, true);
});

test('background batch yields remaining chunks to an interactive reply at a chunk boundary', async () => {
  const source = fs.readFileSync(require.resolve('../bot.js'), 'utf8');
  const a = source.indexOf('async function runTtsBatchJobPipelined('), b = source.indexOf('function shouldUsePipelinedTtsBatch(', a);
  const spoken = [], requeued = [], lane = { queue: [] };
  const context = vm.createContext({ normalizeTtsText: x => x, resolveTtsRuntime: () => ({ ok: true }), log() {}, TTS_SEND_TEXT: false,
    runTtsJob: async job => { spoken.push(job.text); lane.queue.push({ source: 'voice-reply', backgroundVoice: false }); return { ok: true }; },
    enqueueTtsBatch: async (...args) => { requeued.push(args); return true; },
  });
  vm.runInContext(source.slice(a, b), context);
  const job = { chatId: 'news', texts: ['one', 'two', 'three'], kind: 'tts-batch', source: 'voice-reply',
    backgroundVoice: true, ttsPreset: 'voice', workerId: 'general', audioVersion: 2, skipResultText: true };
  assert.equal((await context.runTtsBatchJobPipelined(job, lane)).ok, true);
  assert.deepEqual(spoken, ['one']);
  assert.deepEqual(Array.from(requeued[0][1]), ['two', 'three']);
  assert.equal(requeued[0][3].backgroundVoice, true);
  assert.equal(requeued[0][3].audioVersion, 2);
  assert.equal(requeued[0][3].ttsPreset, 'voice');
});

test('TTS_SEND_TEXT exposes completed answer even while queued voice has not started', async () => {
  const source = fs.readFileSync(require.resolve('../lib/orch_lane_runtime'), 'utf8');
  const a = source.indexOf('const shouldSuppressResultTextForQueuedVoice ='), b = source.indexOf('const combinedAfterText =', a);
  const sent = [];
  const context = vm.createContext({ shouldVoiceReply: true, voiceQueued: true, isWorldMonitorAlertJob: false,
    isWorldMonitorCheckJob: false, TTS_SEND_TEXT: true, hasForcedTextOnly: false, result: { ok: true, text: 'Ready' },
    job: { chatId: 'chat' }, replyToMessageId: 1, routeWorkerId: 'general', routeTaskId: 0, resolvedSessionId: '',
    normalizeResponse: x => x, sendMessage: async (chat, text) => { sent.push({ chat, text }); }, collectSentMessageIds() {}, log() {}, redactError: x => x });
  await vm.runInContext(`(async()=>{${source.slice(a,b)}})()`, context);
  assert.deepEqual(sent, [{ chat: 'chat', text: 'Ready' }]);
  context.TTS_SEND_TEXT = false; sent.length = 0;
  await vm.runInContext(`(async()=>{${source.slice(a,b)}})()`, context);
  assert.equal(sent.length, 0);
});

test('a timed-out background chunk delivers fallback and still yields to the waiting user', async () => {
  const source=fs.readFileSync(require.resolve('../bot.js'),'utf8');
  const a=source.indexOf('async function runTtsBatchJobPipelined('),b=source.indexOf('function shouldUsePipelinedTtsBatch(',a);
  const spoken=[],fallback=[],requeued=[],lane={queue:[]};
  const context=vm.createContext({normalizeTtsText:x=>x,resolveTtsRuntime:()=>({ok:true}),log(){},TTS_SEND_TEXT:false,oneLine:x=>x,
    runTtsJob:async job=>{spoken.push(job.text);lane.queue.push({source:'voice-reply'});return {ok:false,text:'TTS timed out'};},
    sendMessage:async (chat,text)=>fallback.push(text),getSessionForChatWorker:()=>'',
    enqueueTtsBatch:async (...args)=>{requeued.push(args);return true;},
  });
  vm.runInContext(source.slice(a,b),context);
  await context.runTtsBatchJobPipelined({chatId:'news',texts:['first','second','third'],kind:'tts-batch',source:'voice-reply',backgroundVoice:true,skipResultText:true},lane);
  assert.deepEqual(spoken,['first']);
  assert.equal(fallback.length,1);assert.match(fallback[0],/first/);
  assert.deepEqual(Array.from(requeued[0][1]),['second','third']);
});
