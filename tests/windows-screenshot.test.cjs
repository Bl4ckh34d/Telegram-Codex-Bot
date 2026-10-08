const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {execFileSync}=require('node:child_process');

// Opt-in: this test captures the local desktop into temporary files, never sends it.
test('Windows screenshots use physical pixels at non-100% desktop scaling',{
  skip:process.platform!=='win32'||process.env.AIDOLON_TEST_SCREEN_CAPTURE!=='1'
},async t=>{
  const root=path.resolve(__dirname,'..');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aidolon-screen-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const native=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',
    'Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution -gt 0 } | Select-Object CurrentHorizontalResolution,CurrentVerticalResolution | ConvertTo-Json -Compress'],{windowsHide:true,encoding:'utf8'}));
  if(Array.isArray(native)){t.skip('This physical-resolution check requires one active video controller.');return;}
  const source=fs.readFileSync(path.join(root,'bot.js'),'utf8');
  const start=source.indexOf('async function capturePrimaryScreenshot('),end=source.indexOf('\nfunction ',source.indexOf('async function captureAllScreenshots(',start));
  const c=vm.createContext({fs,path,ROOT:root,process,SCREENSHOT_CAPTURE_TIMEOUT_MS:30000,ensureDir:p=>fs.mkdirSync(p,{recursive:true}),runPowerShellScript:async(script,env)=>execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',script],{cwd:root,env:{...process.env,...env},windowsHide:true,encoding:'utf8',timeout:30000})});
  vm.runInContext(source.slice(start,end),c);
  const primary=path.join(dir,'primary.png');await c.capturePrimaryScreenshot(primary);
  const files=await c.captureAllScreenshots(dir,'all');assert.ok(files.length>0);
  if(files.length!==1){t.skip('Controller-to-monitor mapping is ambiguous with multiple displays.');return;}
  for(const file of [primary,files[0]]){
    const png=fs.readFileSync(file);
    assert.equal(png.readUInt32BE(16),native.CurrentHorizontalResolution,'physical screenshot width');
    assert.equal(png.readUInt32BE(20),native.CurrentVerticalResolution,'physical screenshot height');
  }
  c.ROOT=dir; // Missing DPI helper must fail rather than quietly send a cropped image.
  await assert.rejects(c.capturePrimaryScreenshot(path.join(dir,'unsafe.png')));
  assert.equal(fs.existsSync(path.join(dir,'unsafe.png')),false);
});
