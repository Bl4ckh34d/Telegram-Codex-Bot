const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { readAllowedFile } = require('../lib/file_access');
const { readDataVariable } = require('../lib/data_literals');
const { createJobJournal } = require('../lib/job_journal');
const { createTelegramInbox } = require('../lib/telegram_inbox');
const { createConversationState } = require('../lib/conversation_state');
const { readTextLimited } = require('../lib/network_limits');
const { spawn, terminateChildTree } = require('../lib/process_lifecycle');
function temp(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'aidolon-test-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
const tick = () => new Promise(resolve => setImmediate(resolve));
test('attachments reject outside targets, parent symlinks, directories and oversized files', t => {
  const root = temp(t), allowed = path.join(root, 'allowed'); fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(root, 'private'), 'secret'); fs.writeFileSync(path.join(allowed, 'ok'), 'hello');
  assert.equal(readAllowedFile(path.join(allowed, 'ok'), [allowed], 5).toString(), 'hello');
  assert.throws(() => readAllowedFile(path.join(allowed, 'ok'), [allowed], 4), /limit/);
  // Junctions exercise a real redirected parent without Windows Developer Mode.
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(root, 'private'), path.join(allowed, 'escape'));
    assert.throws(() => readAllowedFile(path.join(allowed, 'escape'), [allowed], 99), /outside/);
  }
  fs.symlinkSync(root, path.join(allowed, 'parent'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readAllowedFile(path.join(allowed, 'parent/private'), [allowed], 99), /outside/);
  assert.throws(() => readAllowedFile(allowed, [allowed], 99), /regular/);
});
test('weather parser reads literals but rejects executable code and prototype keys', () => {
  const result = readDataVariable("var stamp='today'; var weather={rain:[-2,3],sun:true};", 'weather');
  assert.deepEqual(result.rain, [-2,3]);
  for (const text of ["var weather=process.exit();", "var weather={__proto__:1};", "while(true){}", "var weather={x: (()=>1)()};"])
    assert.throws(() => readDataVariable(text, 'weather'));
});
test('job journal survives restart, isolates chats and preserves undelivered output', t => {
  const file = path.join(temp(t), 'jobs.json'); let journal = createJobJournal(file);
  const job = { id: 1, chatId: 'a', text: 'task', kind: 'codex' };
  journal.queued(job); journal.running(job); journal.result(job, { ok: true, text: 'answer' });
  journal = createJobJournal(file);
  assert.equal(journal.pending('a')[0].result.text, 'answer'); assert.equal(journal.pending('b').length, 0);
  assert.equal(journal.dismiss(job.journalId, 'b'), false);
  journal.delivered(job); assert.equal(createJobJournal(file).pending('a').length, 0);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test('inbox persists immediately, serializes a chat and lets other chats advance', async t => {
  const filePath = path.join(temp(t), 'inbox.json'); const seen=[]; let release;
  const blocked = new Promise(resolve => { release=resolve; });
  const inbox = createTelegramInbox({ filePath, onError: err => { throw err; }, handle: async u => { seen.push(u.update_id); if(u.update_id===1) await blocked; } });
  const update = (id, chat) => ({update_id:id,message:{chat:{id:chat},text:'test'}});
  inbox.enqueue(update(1,'a')); inbox.enqueue(update(2,'a')); inbox.enqueue(update(3,'b')); inbox.enqueue(update(1,'a'));
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(filePath))).length, 3);
  await tick(); assert.deepEqual(seen,[1,3]); release(); await tick(); assert.deepEqual(seen,[1,3,2]); assert.equal(inbox.counts(),0);
});
test('inbox never replays a handler interrupted by process death', async t => {
  const filePath = path.join(temp(t), 'inbox.json'); fs.writeFileSync(filePath, JSON.stringify({1:{status:'handling',update:{update_id:1,message:{chat:{id:'a'}}}}}));
  let calls=0; const inbox=createTelegramInbox({filePath,handle:async()=>calls++,onError:()=>{}}); inbox.resume(); await tick();
  assert.equal(calls,0); assert.equal(inbox.pending('a')[0][1].status,'interrupted'); assert.equal(inbox.dismiss('1','b'),false); assert.equal(inbox.dismiss('1','a'),true);
});
test('session resets and speech interruption are scoped independently', () => {
  const state=createConversationState(); const initial=state.sessionVersion('a','w'); state.resetSession('a','w');
  assert.notEqual(state.sessionVersion('a','w'),initial); assert.equal(state.sessionVersion('b','w'),0);
  assert.equal(state.interruptAudio('a'),1); assert.equal(state.audioVersion('b'),0); assert.equal(state.sessionVersion('a','w'),1);
});
test('network text reads enforce byte bounds', async () => {
  assert.equal(await readTextLimited(new Response('hello'),5),'hello'); await assert.rejects(readTextLimited(new Response('hello'),4),/limit/);
});
test('process group cancellation kills a descendant that ignores SIGTERM', {skip:process.platform!=='linux',timeout:5000}, async t => {
  const code = `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']}); c.stdout.on('data',()=>console.log(c.pid)); setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['-e',code],{stdio:['ignore','pipe','pipe']});
  t.after(()=>terminateChildTree(child,{forceAfterMs:0}));
  const [data]=await once(child.stdout,'data'); const pid=Number(String(data).trim()); assert(pid>0);
  await terminateChildTree(child,{forceAfterMs:100});
  for(let i=0;i<30;i++) { try { const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8'); if(stat.split(' ')[2]==='Z') return; } catch(err) { if(err.code==='ENOENT')return; throw err; } await new Promise(r=>setTimeout(r,20)); }
  assert.fail('descendant still running');
});
