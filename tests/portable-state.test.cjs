const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../bot.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a);
  return source.slice(a, b);
}

test('state paths relocate with the checkout without changing arbitrary text or remote paths', () => {
  const { mapStatePaths, encodeLocalPath, decodeLocalPath } = require('../lib/portable_paths');
  const oldRoot = path.resolve('old', 'bot'), newRoot = path.resolve('moved', 'bot');
  const original = { orch: { workers: { general: { workdir: oldRoot }, repo: { workdir: path.resolve(oldRoot, '../app') } } },
    lastImages: { chat: { path: path.join(oldRoot, 'runtime/image.png'), items: [{ path: path.join(oldRoot, 'runtime/other.png') }] } },
    orchLessons: [{ workdirKey: oldRoot.toLowerCase(), text: 'keep /arbitrary/text' }], remote: { cwd: '/remote/work' } };
  const stored = mapStatePaths(original, p => encodeLocalPath(p, oldRoot));
  assert.equal(stored.orch.workers.general.workdir, '.');
  assert.equal(stored.orch.workers.repo.workdir, '../app');
  assert.equal(stored.lastImages.chat.path, 'runtime/image.png');
  const loaded = mapStatePaths(stored, p => decodeLocalPath(p, newRoot));
  assert.equal(loaded.orch.workers.repo.workdir, path.resolve(newRoot, '../app'));
  assert.equal(loaded.lastImages.chat.items[0].path, path.join(newRoot, 'runtime/other.png'));
  assert.equal(loaded.orchLessons[0].text, 'keep /arbitrary/text');
  assert.equal(loaded.remote.cwd, '/remote/work');
  assert.equal(original.orch.workers.general.workdir, oldRoot);
});

test('Windows drives and foreign absolute paths are not made into bogus relative paths', () => {
  const { encodeLocalPath, decodeLocalPath } = require('../lib/portable_paths');
  assert.equal(encodeLocalPath('C:\\old\\bot\\runtime\\x', 'C:\\old\\bot', path.win32), 'runtime/x');
  assert.equal(encodeLocalPath('D:\\models\\x', 'C:\\old\\bot', path.win32), 'D:/models/x');
  assert.equal(decodeLocalPath('D:/models/x', '/home/bot', path.posix), 'D:/models/x');
  assert.equal(encodeLocalPath('C:/old/bot', '/home/bot', path.posix), 'C:/old/bot');
  assert.equal(decodeLocalPath('runtime\\x', '/home/bot', path.posix), '/home/bot/runtime/x');
  assert.equal(decodeLocalPath('', '/home/bot', path.posix), '');
});

test('recovery journal saves relative images and resolves them after moving', t => {
  const { createJobJournal } = require('../lib/job_journal');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidolon-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'jobs.json');
  const journal = createJobJournal(file, { baseDir: root });
  const job = { id: 1, chatId: '123', imagePaths: [path.join(root, 'runtime/image.png')] };
  journal.queued(job);
  assert.equal(Object.values(JSON.parse(fs.readFileSync(file)))[0].imagePaths[0], 'runtime/image.png');
  const moved = path.join(root, 'new-location');
  assert.equal(createJobJournal(file, { baseDir: moved }).pending('123')[0].imagePaths[0], path.join(moved, 'runtime/image.png'));
});

test('worker paths are anchored to bot root, not caller cwd', () => {
  const { createOrchWorkerRuntime } = require('../lib/orch_worker_runtime');
  const root = path.resolve('isolated-bot');
  const runtime = createOrchWorkerRuntime({ fs, path, ROOT: root });
  assert.equal(runtime.resolveWorkdirInput('../repo'), path.resolve(root, '../repo'));
});

test('foreign workspace paths cannot accidentally execute in a matching local directory', () => {
  const { createOrchWorkerRuntime } = require('../lib/orch_worker_runtime');
  const { createOrchLaneRegistryRuntime } = require('../lib/orch_lane_registry_runtime');
  for (const [paths, root, foreign] of [[path.win32, 'C:\\bot', '/home/user/repo'], [path.posix, '/bot', 'C:\\repo']]) {
    const deps = { path: paths, ROOT: root, fs: { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) } };
    const workers = createOrchWorkerRuntime(deps), lanes = createOrchLaneRegistryRuntime(deps);
    assert.equal(workers.resolveWorkdirInput(foreign), foreign);
    assert.throws(() => workers.createRepoWorker(foreign), /workspace directory/);
    assert.throws(() => lanes.resolveUsableWorkdir(foreign), /Workspace directory is unavailable/);
    assert.throws(() => lanes.refreshLaneWorkdir({ id: 'foreign', workdir: foreign }), /Workspace directory is unavailable/);
  }
});

function monitorContext({ stored = 'stale', configured = '', validStored = false } = {}) {
  const workers = { general: { id: 'general', title: 'General', workdir: '/bot' },
    stale: { id: 'stale', title: 'WorldMonitor Intel', workdir: validStored ? '/valid' : '/missing' },
    custom: { id: 'custom', title: 'Custom', workdir: '/custom' } };
  const c = vm.createContext({ worldMonitorMonitor: { workerId: stored }, WORLDMONITOR_WORKDIR: configured,
    WORLDMONITOR_WORKER_TITLE: 'WorldMonitor Intel', ORCH_GENERAL_WORKER_ID: 'general', ORCH_MAX_CODEX_WORKERS: 5,
    fs: { existsSync: p => ['/bot', '/valid', '/custom', '/file'].includes(p), statSync: p => {
      if (!['/bot', '/valid', '/custom', '/file'].includes(p)) throw new Error('ENOENT');
      return { isDirectory: () => p !== '/file' };
    } },
    path, isForeignAbsolute: () => false,
    getCodexWorker: id => workers[id], listCodexWorkers: () => Object.values(workers),
    findWorkerByWorkdir: p => Object.values(workers).find(w => w.workdir === p)?.id || '',
    createRepoWorker: () => { throw new Error('unexpected creation'); }, persistState() {}, log() {}, redactError: x => x });
  vm.runInContext(section('function ensureWorldMonitorWorker()', 'async function fetchWorldMonitorRiskSnapshot('), c);
  return c;
}
test('native WorldMonitor replaces missing stored workspace with general worker', () => {
  const c = monitorContext();
  assert.equal(c.ensureWorldMonitorWorker(), 'general');
  assert.equal(c.worldMonitorMonitor.workerId, 'general');
});
test('explicit WorldMonitor workspace overrides a valid stored worker', () => {
  assert.equal(monitorContext({ configured: '/custom', validStored: true }).ensureWorldMonitorWorker(), 'custom');
});
test('WorldMonitor keeps an existing valid worker and does not accept a file as workspace', () => {
  assert.equal(monitorContext({ validStored: true }).ensureWorldMonitorWorker(), 'stale');
  assert.equal(monitorContext({ configured: '/file' }).ensureWorldMonitorWorker(), 'general');
});

test('group voice authorization requires both allowed group and allowed sender', () => {
  const c = vm.createContext({ splitRoute: id => ({ chatId: String(id) }), ALLOWED_CHAT_IDS: new Set(['owner', 'group']),
    ALLOWED_USER_IDS: new Set(['owner']), ALLOW_GROUP_CHAT: true });
  vm.runInContext(section('function isAllowedMessage(', 'function describeTelegramChatForLog('), c);
  const voice = { chat: { id: 'group', type: 'supergroup' }, from: { id: 'owner' }, voice: { file_id: 'voice' } };
  assert.equal(c.isAllowedMessage(voice), true);
  assert.equal(c.isAllowedMessage({ ...voice, from: { id: 'stranger' } }), false);
  assert.equal(c.isAllowedMessage({ ...voice, chat: { id: 'other', type: 'supergroup' } }), false);
  c.ALLOW_GROUP_CHAT = false;
  assert.equal(c.isAllowedMessage(voice), false);
});

test('all reply styles receive shared host and memory rules even with custom prompts', () => {
  const c = vm.createContext({ ORCH_ROUTER_PROMPT_FILE: 'router', CODEX_VOICE_PROMPT_FILE: 'voice', CODEX_PROMPT_FILE: 'text',
    CODEX_SHARED_RULES_FILE: 'rules', readTextFileCached: p => p === 'rules' ? 'Shared Obsidian lookup and capture' : 'Custom style',
    defaultRouterPromptPreamble: () => '', defaultVoicePromptPreamble: () => '', defaultPromptPreamble: () => '' });
  vm.runInContext(section('function getPromptPreamble(', 'function formatCodexPrompt('), c);
  for (const style of ['text', 'voice', 'router']) {
    assert.match(c.getPromptPreamble(style), /Custom style/);
    assert.match(c.getPromptPreamble(style), /Shared Obsidian lookup and capture/);
  }
});
