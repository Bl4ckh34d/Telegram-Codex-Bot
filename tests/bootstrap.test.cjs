const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
test('bot modules initialize with isolated state and no Telegram polling',t=>{
  const root=path.resolve(__dirname,'..'), dir=fs.mkdtempSync(path.join(os.tmpdir(),'aidolon-bootstrap-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const name of ['lib','node_modules','schemas'])fs.symlinkSync(path.join(root,name),path.join(dir,name),process.platform==='win32'?'junction':'dir');
  const source=fs.readFileSync(path.join(root,'bot.js'),'utf8'); const end=source.lastIndexOf('(async () => {'); assert(end>0);
  fs.writeFileSync(path.join(dir,'bot.js'),source.slice(0,end)+'\nreleaseProcessLock(LOCK_PATH); process.exit(0);\n');
  const result=spawnSync(process.execPath,[path.join(dir,'bot.js')],{cwd:dir,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,HOME:dir,TELEGRAM_BOT_TOKEN:'test:placeholder',TELEGRAM_CHAT_ID:'123',BOT_REQUIRE_TTY:'0',CODEX_BIN:process.execPath,CODEX_WORKDIR:dir,CODEX_USE_WSL:'0'}});
  assert.equal(result.status,0,result.stderr||result.error?.message);
});

test('bot loads relocated state from repo root even when launched elsewhere',t=>{
  const root=path.resolve(__dirname,'..'), dir=fs.mkdtempSync(path.join(os.tmpdir(),'aidolon-relocated-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const name of ['lib','node_modules','schemas'])fs.symlinkSync(path.join(root,name),path.join(dir,name),process.platform==='win32'?'junction':'dir');
  fs.mkdirSync(path.join(dir,'runtime'));
  fs.mkdirSync(path.join(dir,'project'));
  fs.writeFileSync(path.join(dir,'runtime','image.png'),'test');
  fs.writeFileSync(path.join(dir,'runtime','state.json'),JSON.stringify({
    lastImages:{123:{path:'runtime/image.png'}},
    orch:{workers:{w1:{id:'w1',kind:'repo',title:'Project',workdir:'project'}}},
  }));
  const source=fs.readFileSync(path.join(root,'bot.js'),'utf8');
  const end=source.lastIndexOf('(async () => {'); assert(end>0);
  fs.writeFileSync(path.join(dir,'bot.js'),source.slice(0,end)+`
    const assert = require('node:assert/strict');
    assert.equal(CODEX_WORKDIR, ROOT);
    assert.equal(getCodexWorker('w1').workdir, path.join(ROOT, 'project'));
    assert.equal(resolveWorkdirInput('project'), path.join(ROOT, 'project'));
    assert.equal(getLastImageForChat('123').path, path.join(ROOT, 'runtime/image.png'));
    const snapshot = buildStateSnapshot();
    assert.equal(snapshot.orch.workers.general.workdir, '.');
    assert.equal(snapshot.orch.workers.w1.workdir, 'project');
    assert.equal(snapshot.lastImages['123'].path, 'runtime/image.png');
    releaseProcessLock(LOCK_PATH); process.exit(0);
  `);
  const result=spawnSync(process.execPath,[path.join(dir,'bot.js')],{cwd:os.tmpdir(),encoding:'utf8',timeout:10000,
    env:{PATH:process.env.PATH,HOME:dir,TELEGRAM_BOT_TOKEN:'test:placeholder',TELEGRAM_CHAT_ID:'123',BOT_REQUIRE_TTY:'0',CODEX_BIN:process.execPath,CODEX_WORKDIR:'.',CODEX_USE_WSL:'0'}});
  assert.equal(result.status,0,result.stderr||result.error?.message);
});
