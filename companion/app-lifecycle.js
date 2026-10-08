'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');

function localThreadPresence(file,contextThreadId) {
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(file||path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'state_5.sqlite'),{readOnly:true});
  try {
    const rows=db.prepare('SELECT id, archived FROM threads').all();
    if(!rows.some(x=>x.id===contextThreadId))throw Error('App context missing from local metadata; deletion reconciliation unavailable.');
    return {complete:true,hostId:'local',ids:rows.map(x=>x.id),archivedIds:rows.filter(x=>x.archived).map(x=>x.id)};
  } finally {db.close();}
}

function localProjects(result) {
  if(!Array.isArray(result?.projects))throw Error('App project catalog unavailable.');
  return result.projects.filter(x=>x.projectKind==='local'&&x.hostId==='local'&&typeof x.projectId==='string');
}

async function createAppThread(input,config,call) {
  if(!/^[0-9a-f-]{36}$/i.test(input.requestId||''))throw Error('Valid requestId required.');
  if(typeof input.text!=='string'||!input.text.trim()||input.text.length>30000)throw Error('Initial message of 1–30000 characters required.');
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify([input.projectId||null,input.text,input.title||null])).digest('hex');
  const root=config.creationRoot||path.resolve(__dirname,'../runtime/app-creations');
  fs.mkdirSync(root,{recursive:true});
  const file=path.join(root,input.requestId+'.json');
  if(fs.existsSync(file)) {
    const old=JSON.parse(fs.readFileSync(file,'utf8'));
    if(old.fingerprint!==fingerprint)throw Error('requestId already used for different input.');
    if(old.result)return old.result;
    throw Error('Previous app creation is unconfirmed. Inspect the app before starting another chat.');
  }
  const projects=localProjects(await call('list_projects',{}));
  if(input.projectId&&!projects.some(x=>x.projectId===input.projectId))throw Error('Selected local project no longer available.');
  const target=input.projectId?{type:'project',projectId:input.projectId,environment:{type:'local'}}:{type:'projectless'};
  const args={prompt:input.text,target};
  if(input.title)args.title=String(input.title).slice(0,128);
  // Exclusive creation also serializes duplicate callbacks/processes before IPC.
  fs.writeFileSync(file,JSON.stringify({fingerprint,status:'pending',at:Date.now()}),{flag:'wx'});
  const result=await call('create_thread',args);
  const temp=file+'.tmp';
  fs.writeFileSync(temp,JSON.stringify({fingerprint,status:'returned',result,at:Date.now()}));fs.renameSync(temp,file);
  return result;
}
module.exports={localThreadPresence,localProjects,createAppThread};
