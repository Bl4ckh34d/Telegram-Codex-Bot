"use strict";
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
function pipeRequest(pipePath, method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath); let data = Buffer.alloc(0); let done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(result);};
    const timer=setTimeout(()=>finish(new Error('App request timed out; delivery is unknown. Do not resend automatically.')),timeoutMs);
    socket.on('error',err=>finish(err)); socket.on('close',()=>finish(new Error('App connection closed; delivery is unknown.')));
    socket.on('connect',()=>{const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method,params}));const header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]));});
    socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length<4)return;const size=data.readUInt32LE(0);if(size>8*1024*1024)return finish(new Error('App response too large'));if(data.length<size+4)return;
      try{const reply=JSON.parse(data.subarray(4,size+4));if(reply.id!==1)throw new Error('Unexpected app response');finish(reply.error?new Error(reply.error.message):null,reply.result);}catch(err){finish(err);}
    });
  });
}
const discoveredPipes=new Map();
async function discoverPipe(contextThreadId,request=pipeRequest,candidates) {
  if(!candidates){
    const configured=process.env.CODEX_APP_TOOLS_PIPE_PATH;
    if(process.platform!=='win32'){
      if(configured)return configured;
      throw new Error('Configure the running Codex app Unix socket as pipePath in runtime/app-bridge.json.');
    }
    // stat/existsSync opens a named pipe and intermittently fails when busy.
    // Directory enumeration does not consume a connection slot.
    candidates=[...new Set(fs.readdirSync('\\\\.\\pipe\\'))].filter(name=>/^codex-browser-use-[0-9a-f-]{36}$/i.test(name)).map(name=>`\\\\.\\pipe\\${name}`);
    if(configured&&candidates.includes(configured))return configured;
  }
  const cached=discoveredPipes.get(contextThreadId);
  if(cached&&candidates.includes(cached))return cached;
  if(candidates.length===1)return candidates[0];
  const deadline=Date.now()+10000;
  for(const pipe of candidates){
    if(Date.now()>=deadline)throw new Error('Codex app discovery exceeded 10 seconds. Configure pipePath in runtime/app-bridge.json.');
    try{
      const result=await request(pipe,'tools/call',{callerSource:'codex',namespace:'codex_app',tool:'read_thread',arguments:{threadId:contextThreadId,hostId:'local',turnLimit:1,maxOutputCharsPerItem:1},threadId:contextThreadId,turnId:'aidolon-discovery',callId:crypto.randomUUID()},2000);
      if(!result.success)continue;
      const text=(result.contentItems||[]).filter(x=>x.type==='inputText').map(x=>x.text).join('\n');
      const thread=JSON.parse(text).thread;
      if(thread?.id===contextThreadId&&thread.kind==='codex'&&thread.hostId==='local'){discoveredPipes.set(contextThreadId,pipe);return pipe;}
    }catch{/* Only read-only discovery is retried. Never retry a send. */}
  }
  throw new Error('Running Codex app context not found. Open Codex or configure contextThreadId/pipePath in runtime/app-bridge.json.');
}
// Read-only fallback: this app build omits some newly completed messages from
// read_thread. Completed response_item messages are persisted by the same app.
function findLatestRollout(root, threadId) {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) return null;
  const candidates=fs.readdirSync(root,{recursive:true})
    .filter(name=>name.endsWith('.jsonl')&&name.includes(threadId))
    .map(name=>{const file=path.join(root,name);return {file,mtime:fs.statSync(file).mtimeMs};})
    .sort((a,b)=>b.mtime-a.mtime || b.file.localeCompare(a.file));
  for(const candidate of candidates) {
    // Resumed incarnations can share the logical thread ID in their filename.
    // Validate metadata too: an incidental filename match is not ownership.
    const fd=fs.openSync(candidate.file,'r');
    try {
      const buffer=Buffer.alloc(65536), count=fs.readSync(fd,buffer,0,buffer.length,0);
      const first=buffer.subarray(0,count).toString('utf8').split('\n')[0];
      let meta;try{meta=JSON.parse(first);}catch{continue;}
      if(meta.type==='session_meta'&&meta.payload?.id===threadId)return candidate.file;
    } finally {fs.closeSync(fd);}
  }
  return null;
}
function localMessages(threadId, root=path.join(require('node:os').homedir(),'.codex','sessions')) {
  const file=findLatestRollout(root,threadId);
  if(!file)return null;
  const fd=fs.openSync(file,'r');let text;
  try {const size=fs.fstatSync(fd).size;const start=Math.max(0,size-4*1024*1024);const buffer=Buffer.alloc(size-start);fs.readSync(fd,buffer,0,buffer.length,start);text=buffer.toString('utf8');if(start)text=text.slice(text.indexOf('\n')+1);}finally{fs.closeSync(fd);}
  return parseRolloutMessages(text);
}
function parseRolloutMessages(text) {
  const items=[];
  for(const line of text.split('\n').slice(0,-1)){
    let row;try{row=JSON.parse(line);}catch{continue;}
    const p=row.payload;
    if(row.type!=='response_item'||p?.type!=='message'||p.role!=='assistant'||!['commentary','final_answer'].includes(p.phase))continue;
    const message=(p.content||[]).filter(x=>x.type==='output_text').map(x=>x.text||'').join('\n');if(!message.trim())continue;
    items.push({type:'agentMessage',id:p.id||crypto.createHash('sha256').update(String(row.timestamp)+message).digest('hex'),text:message,phase:p.phase,complete:true});
  }
  return items.slice(-200);
}
async function appRequest(input, config, {request=pipeRequest}={}) {
  config=config||JSON.parse(fs.readFileSync(path.resolve(__dirname,'../runtime/app-bridge.json'),'utf8'));
  if(input.action==='capabilities')return {attachments:1,maxAttachmentBytes:require('./app-attachments').MAX_BYTES};
  const contextThreadId=config.contextThreadId||process.env.CODEX_THREAD_ID||require('./app-local-catalog').localThreadCatalog(config.stateDatabase)[0]?.id;
  if(!contextThreadId)throw new Error('Open a Codex app chat or configure contextThreadId in runtime/app-bridge.json');
  if(input.action==='projects'||input.action==='create') {
    const pipe=config.pipePath||await discoverPipe(contextThreadId,request);
    const call=async(tool,args)=>{
      const result=await request(pipe,'tools/call',{callerSource:'codex',namespace:'codex_app',tool,arguments:args,threadId:contextThreadId,turnId:'aidolon-telegram',callId:crypto.randomUUID()});
      const text=(result.contentItems||[]).filter(x=>x.type==='inputText').map(x=>x.text).join('\n');
      if(!result.success)throw Error(text||'App request rejected');
      return JSON.parse(text);
    };
    const lifecycle=require('./app-lifecycle');
    if(input.action==='create')return lifecycle.createAppThread(input,config,call);
    const catalog=await request(pipe,'tools/list',{threadStartKind:'all'});
    if(!catalog.tools?.some(t=>t.namespace==='codex_app'&&t.name==='create_thread'))throw Error('This app version cannot create chats.');
    return {projects:lifecycle.localProjects(await call('list_projects',{}))};
  }
  const allowed={list:'list_threads',read:'read_thread',send:'send_message_to_thread',archive:'set_thread_archived',rename:'set_thread_title'};
  const tool=allowed[input.action];if(!tool)throw new Error('Unknown app bridge action');
  const args=input.action==='list'?{limit:50}:{threadId:String(input.threadId||''),...(input.hostId?{hostId:String(input.hostId)}:{})};
  if(input.action!=='list'&&!args.threadId)throw new Error('threadId required');
  if(input.action==='archive')Object.assign(args,{source:'codex',archived:true});
  if(input.action==='rename'){
    if(typeof input.title!=='string'||!input.title.trim()||Array.from(input.title).length>128)throw Error('Nonempty title up to 128 characters required.');
    if(input.hostId&&input.hostId!=='local')throw Error('Native title setter cannot safely select a remote app host.');
    delete args.hostId;Object.assign(args,{source:'codex',title:input.title.trim()});
  }
  if(input.action==='read')Object.assign(args,{turnLimit:3,includeOutputs:false,maxOutputCharsPerItem:12000});
  let attachmentDelivery;
  if(input.action==='send'){
    if(typeof input.text!=='string'||input.text.length>30000||(!input.text.trim()&&!input.attachments?.length))throw new Error('Nonempty text up to 30000 characters required');
    if(input.attachments?.length)attachmentDelivery=require('./app-attachments').prepareAttachments(input,config.attachmentRoot||path.resolve(__dirname,'../runtime/app-attachments'));
    args.prompt=attachmentDelivery?.prompt||input.text;
  }
  const pipe=config.pipePath||await discoverPipe(contextThreadId,request);
  let result;
  try{result=await request(pipe,'tools/call',{callerSource:'codex',namespace:'codex_app',tool,arguments:args,threadId:contextThreadId,turnId:'aidolon-telegram',callId:crypto.randomUUID()});}
  catch(e){discoveredPipes.delete(contextThreadId);throw e;}
  const text=(result.contentItems||[]).filter(x=>x.type==='inputText').map(x=>x.text).join('\n');
  if(!result.success)throw new Error(text||'App request rejected');
  attachmentDelivery?.confirm();
  let parsed;try{parsed=JSON.parse(text);}catch{return {text};}
  if(input.action==='list' && config.includeLocalCatalog!==false){
    try{
      const known=new Set([...(parsed.threads||[]),...(parsed.pinnedThreads||[])].filter(x=>x.kind==='codex'&&x.hostId==='local').map(x=>x.id));
      parsed.threads=[...(parsed.threads||[]),...require('./app-local-catalog').localThreadCatalog(config.stateDatabase).filter(x=>!known.has(x.id))];
      parsed.localPresence=require('./app-lifecycle').localThreadPresence(config.stateDatabase,contextThreadId);
    }catch(e){parsed.errors=[...(parsed.errors||[]),`Vollständiger lokaler Chat-Katalog nicht verfügbar; nur die letzten 50 Chats: ${e.message}`];}
  }
  if(input.action==='read' && parsed.thread?.hostId==='local' && parsed.thread?.kind==='codex') {
    const items=localMessages(input.threadId);
    if(items) return {thread:parsed.thread,turns:[{id:`rollout:${input.threadId}`,items}]};
  }
  if(input.action==='read') return {thread:parsed.thread,turns:(parsed.turns||[]).map(t=>({id:t.id,status:t.status,items:(t.items||[]).flatMap((i,n)=>i.type==='agentMessage'?[{type:i.type,id:i.id,text:i.text,phase:i.phase,complete:n<t.items.length-1||t.status!=='inProgress'}]:[])}))};
  return parsed;
}
module.exports={appRequest,pipeRequest,discoverPipe,parseRolloutMessages,findLatestRollout,localMessages};
