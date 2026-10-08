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
