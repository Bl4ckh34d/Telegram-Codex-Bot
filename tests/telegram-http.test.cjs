const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const dns = require('node:dns');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { combineAbortSignals } = require('../lib/core_utils');
const { byteLimit } = require('../lib/network_limits');
const source = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a); return source.slice(a, b);
}
test('production Telegram transport supports GET, JSON, multipart and file download over HTTP', async t => {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({method:req.method, body:Buffer.concat(chunks).toString(), type:req.headers['content-type']});
    if(req.url.includes('/file/')) { res.end('voice-bytes'); return; }
    res.setHeader('content-type','application/json'); res.end(JSON.stringify({ok:true,result:{id:123}}));
  });
  server.listen(0, '127.0.0.1'); await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aidolon-http-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const c=vm.createContext({require, dns, AbortController, AbortSignal, setTimeout, clearTimeout,
    TOKEN:'test', TELEGRAM_API_TIMEOUT_MS:2000, TELEGRAM_UPLOAD_TIMEOUT_MS:2000,
    combineAbortSignals, fs, Readable, pipeline, byteLimit,
    ...require("../lib/telegram_topics"),
    isRetryableTelegramNetworkError:()=>false});
  // Use the actual import and dispatcher factory so a version mismatch regresses this test.
  vm.runInContext(source.match(/^const \{[^\n]+\} = require\("undici"\);$/m)[0]+'\n'+section('function createTelegramFetchDispatcher(', 'loadEnv(ENV_PATH);')+'\nconst TELEGRAM_FETCH_DISPATCHER = createTelegramFetchDispatcher("ipv4first");', c);
  t.after(()=>vm.runInContext('TELEGRAM_FETCH_DISPATCHER.close()',c));
  const methods = section('function formatTimeoutDuration(', 'function parseTelegramStatusFromError(')
    +section('async function downloadTelegramFile(', 'function rejectWhisperKeepalivePending(');
  vm.runInContext(methods.replaceAll('https://api.telegram.org',`http://localhost:${server.address().port}`), c);
  assert.equal((await c.telegramApi('getMe')).id,123);
  await c.telegramApi('example',{body:{text:'hello'}});
  const form=vm.runInContext("new FormData()",c); form.append('voice',new Blob(['audio']),'voice.ogg');
  await c.telegramApiMultipart('upload',form);
  const target=path.join(dir,'voice'); assert.equal(await c.downloadTelegramFile('voice.ogg',target),11);
  assert.equal(fs.readFileSync(target,'utf8'),'voice-bytes');
  assert.equal(received[0].method,'GET'); assert.equal(received[1].body,'{"text":"hello"}');
  assert.match(received[2].type,/multipart\/form-data; boundary=/); assert.match(received[2].body,/audio/);
  await c.telegramApi('sendMessage',{body:{chat_id:'-10042~20',text:'topic reply'}});
  assert.deepEqual(JSON.parse(received.at(-1).body),{chat_id:'-10042',message_thread_id:20,text:'topic reply'});
  const topicForm=vm.runInContext('new FormData()',c);
  topicForm.set('chat_id','-10042~21');topicForm.set('voice',new Blob(['audio']),'voice.ogg');
  await c.telegramApiMultipart('sendVoice',topicForm);
  assert.match(received.at(-1).body,/name="message_thread_id"\r\n\r\n21/);
  assert.doesNotMatch(received.at(-1).body,/-10042~21/);

});
