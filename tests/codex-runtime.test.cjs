const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');

// Exercise the real functions without starting polling or loading local secrets.
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a);
  return source.slice(a, b);
}
function recoveryContext(attempt) {
  const c = vm.createContext({ readJson: () => ({}), path, RUNTIME_DIR: "/tmp", isSessionId: () => false, runCodexJobAttempt: attempt,
    shouldUseCodexOutputSchema: j => !j.omitOutputSchema,
    emitCodexTerminalLine() {} });
  vm.runInContext(section('async function runCodexJob(', 'async function runCodexJobAttempt('), c);
  return c;
}
test('rejected resume input retries once without schema and keeps the original job', async () => {
  const options = [];
  const job = { resumeSessionId: 'session', codexEventTail: 'old error', stdoutTail: 'old output' };
  const c = recoveryContext(async j => {
    assert.equal(j, job);
    options.push(j.omitOutputSchema === true);
    if (options.length === 1) return { ok: false, inputSchemaRejected: true };
    assert.equal(j.codexEventTail, undefined);
    assert.equal(j.stdoutTail, '');
    return { ok: true, text: 'answer' };
  });
  assert.equal((await c.runCodexJob(job)).text, 'answer');
  assert.deepEqual(options, [false, true]);
  assert.equal(job.omitOutputSchema, undefined);
});
test('a second schema rejection does not loop', async () => {
  let calls = 0;
  const c = recoveryContext(async () => { calls++; return { ok: false, inputSchemaRejected: true }; });
  assert.equal((await c.runCodexJob({ resumeSessionId: 'session' })).ok, false);
  assert.equal(calls, 2);
});
for (const [name, job, result] of [
  ['new session', {}, { ok: false, inputSchemaRejected: true }],
  ['accepted turn', { resumeSessionId: 's', codexTurnStarted: true }, { ok: false, inputSchemaRejected: true }],
  ['canceled job', { resumeSessionId: 's', cancelRequested: true }, { ok: false, inputSchemaRejected: true }],
  ['timeout', { resumeSessionId: 's', timedOut: true }, { ok: false, inputSchemaRejected: true }],
  ['ordinary failure', { resumeSessionId: 's' }, { ok: false, text: 'tool failed' }],
  ['schema already omitted', { resumeSessionId: 's', omitOutputSchema: true }, { ok: false, inputSchemaRejected: true }],
]) {
  test(`${name} is not retried`, async () => {
    let calls = 0;
    const c = recoveryContext(async () => { calls++; return result; });
    assert.equal(await c.runCodexJob(job), result);
    assert.equal(calls, 1);
  });
}
function attemptContext({ code, signal = null, stderr = '', jsonEvents = true }) {
  const c = vm.createContext({
    buildCodexExecSpec: () => ({ bin: 'fake', args: [], cwd: '/tmp', stdinText: '', jsonEvents }),
    resolveUsableWorkdir: p => p, log() {}, emitCodexTerminalLine() {}, truncateLine: x => x,
    CODEX_TIMEOUT_MS: 0, CODEX_STREAM_OUTPUT_TO_TERMINAL: false,
    fs: { existsSync: () => false }, extractSessionIdFromText: () => '',
    setTimeout, clearTimeout, appendTail: (a, b) => a + b,
    ingestCodexJsonChunk() {}, flushCodexJsonRemainders() {},
    spawn: () => {
      const child = new EventEmitter(); child.stdin = { end() {} };
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      setImmediate(() => { child.stderr.emit('data', stderr); child.emit('close', code, signal); });
      return child;
    },
  });
  vm.runInContext(section('async function runCodexJobAttempt(', 'async function processLane('), c);
  return c;
}
test('signal exit is a failure', async () => {
  const c = attemptContext({ code: null, signal: 'SIGKILL' });
  const r = await c.runCodexJobAttempt({ stdoutTail: '', stderrTail: '' });
  assert.equal(r.ok, false);
  assert.match(r.text, /SIGKILL/);
});
const rejection = 'Error: turn/start: failed to submit turn input: ActiveTurnOutputSchemaMismatch (code -32603)';
test('only explicit pre-submission schema rejection enables recovery', async () => {
  for (const [stderr, jsonEvents, started, expected] of [
    [rejection, true, false, true],
    [rejection, true, true, false],
    [rejection, false, false, false],
    ['Tool error: ActiveTurnOutputSchemaMismatch', true, false, false],
  ]) {
    const c = attemptContext({ code: 1, stderr, jsonEvents });
    const r = await c.runCodexJobAttempt({ stdoutTail: '', stderrTail: '', codexTurnStarted: started });
    assert.equal(Boolean(r.inputSchemaRejected), expected);
  }
});
test('German status request stays local; discussion of status code is not intercepted', () => {
  const c = vm.createContext({});
  vm.runInContext(section('function looksLikeSafeCommandMetaText(', 'async function maybeHandleNaturalSafeCommandRequest('), c);
  for (const text of ['Gib mir mal den Status Check.', 'Zeig mir bitte den Status.', 'Status check']) {
    const r = c.parseNaturalSafeCommandIntent(text);
    assert.equal(r.cmd, '/status');
    assert(r.confidence >= 0.9);
  }
  for (const text of ['Verbessere den Status Check im Code.', 'Gib mir mal den Status Check und starte das Projekt.']) {
    assert.equal(c.parseNaturalSafeCommandIntent(text).matched, false);
  }
});
test('Astra picker supports six efforts; switching models filters incompatible efforts', () => {
  const c = vm.createContext({ nativeModelCatalog: [], CODEX_MODEL: 'gpt-5.5', CODEX_MODEL_CHOICES: [],
    CODEX_REASONING_EFFORT: 'medium', CODEX_REASONING_EFFORT_CHOICES: [],
    normalizeCodexModelName: v => String(v || '').trim() });
  vm.runInContext(section('const CODEX_DEFAULT_MODEL_CHOICES', 'const CODEX_STREAM_OUTPUT_TO_TERMINAL')
    + section('function getEffectiveModelChoices()', 'function buildModelPickerPayload('), c);
  assert(c.getEffectiveModelChoices().includes('gpt-6-astra'));
  assert.deepEqual(Array.from(c.getEffectiveReasoningChoicesForModel('gpt-6-astra')),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(c.normalizeReasoningForModel('gpt-5.5', 'ultra'), '');
  assert.equal(c.pickDefaultReasoningForModel('gpt-5.5'), 'medium');
});


test('only an outer stdout thread.started event can select the session', () => {
  const c = vm.createContext({ isSessionId: x => /^[0-9a-f-]{36}$/.test(String(x)) });
  vm.runInContext(section('function getCodexSessionIdFromEvent(', 'function normalizeCodexEventType('), c);
  const id = '019f23e2-f1cd-79a2-a43e-21628939193e';
  assert.equal(c.getCodexSessionIdFromEvent({type:'thread.started',thread_id:id}),id);
  assert.equal(c.getCodexSessionIdFromEvent({type:'thread.started',thread_id:id},'stderr'),'');
  for (const event of [
    {type:'item.completed',item:{type:'command_execution',aggregated_output:JSON.stringify({type:'thread.started',thread_id:id})}},
    {type:'item.completed',item:{type:'agent_message',text:'session id: '+id}},
    {type:'item.completed',item:{thread_id:id}},
    {type:'wrapper',payload:{type:'thread.started',thread_id:id}},
  ]) assert.equal(c.getCodexSessionIdFromEvent(event),'');
});

test('companion tool output cannot overwrite an already established session', () => {
  const c = vm.createContext({ isSessionId: x => /^[0-9a-f-]{36}$/.test(String(x)),
    extractCodexEventPayload: e => ({type:e.type,payload:e}),
    rememberCodexAuditCall(){}, emitCodexTerminalAudit(){}, appendCodexMessageDelta(){},
    extractCodexFinalTextFromEvent:()=>'', maybeHandleCodexReasoningProgress:()=>false,
    flushCodexReasoningProgress(){}, formatCodexJsonEventProgress:()=>'' });
  vm.runInContext(section('function getCodexSessionIdFromEvent(', 'function normalizeCodexEventType(')
    +section('function ingestCodexJsonLine(', 'function ingestCodexJsonChunk('),c);
  const parent='019f23e2-f1cd-79a2-a43e-21628939193e', foreign='01a07bff-4c40-7960-9943-51ba748bb811';
  const job={}; c.ingestCodexJsonLine(job,JSON.stringify({type:'thread.started',thread_id:parent}));
  c.ingestCodexJsonLine(job,JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:JSON.stringify({type:'thread.started',thread_id:foreign})}}));
  assert.equal(job.codexSessionId,parent);
});

test('explicit repair resumes the original session without starting a replacement chat', async () => {
  const original='019f23e2-f1cd-79a2-a43e-21628939193e';
  const c=recoveryContext(async job=>{assert.equal(job.resumeSessionId,original);return {ok:true,sessionId:original};});
  c.readJson=()=>({broken:original}); c.isSessionId=x=>x===original;
  assert.equal((await c.runCodexJob({resumeSessionId:'broken'})).sessionId,original);
});
