"use strict";
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
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
function discoverPipe() {
  if(process.env.CODEX_APP_TOOLS_PIPE_PATH)return process.env.CODEX_APP_TOOLS_PIPE_PATH;
  if(process.platform!=='win32')throw new Error('Configure the running Codex app Unix socket as pipePath in runtime/app-bridge.json (or CODEX_APP_TOOLS_PIPE_PATH). Desktop and terminal tools work independently of the app bridge.');
  const output=execFileSync('powershell.exe',['-NoProfile','-Command',"Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'codex.exe' -and $_.CommandLine -match 'CODEX_APP_TOOLS_PIPE_PATH'} | Select-Object -ExpandProperty CommandLine"],{encoding:'utf8',timeout:10000,windowsHide:true});
  const names=[...new Set(output.match(/codex-browser-use-[0-9a-f-]{36}/g)||[])];
  if(names.length!==1)throw new Error('Cannot uniquely identify running Codex app. Configure pipePath in runtime/app-bridge.json.');
  return `\\\\.\\pipe\\${names[0]}`;
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
async function appRequest(input) {
  const config=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../runtime/app-bridge.json'),'utf8'));
  if(!config.contextThreadId)throw new Error('Missing contextThreadId in runtime/app-bridge.json');
  const allowed={list:'list_threads',read:'read_thread',send:'send_message_to_thread'};
  const tool=allowed[input.action];if(!tool)throw new Error('Unknown app bridge action');
  const args=input.action==='list'?{limit:15}:{threadId:String(input.threadId||''),...(input.hostId?{hostId:String(input.hostId)}:{})};
  if(input.action!=='list'&&!args.threadId)throw new Error('threadId required');
  if(input.action==='read')Object.assign(args,{turnLimit:3,includeOutputs:false,maxOutputCharsPerItem:12000});
  if(input.action==='send'){if(typeof input.text!=='string'||!input.text.trim()||input.text.length>30000)throw new Error('Nonempty text up to 30000 characters required');args.prompt=input.text;}
  const result=await pipeRequest(config.pipePath||discoverPipe(),'tools/call',{namespace:'codex_app',tool,arguments:args,threadId:config.contextThreadId,turnId:'aidolon-telegram',callId:crypto.randomUUID()});
  const text=(result.contentItems||[]).filter(x=>x.type==='inputText').map(x=>x.text).join('\n');
  if(!result.success)throw new Error(text||'App request rejected');
  let parsed;try{parsed=JSON.parse(text);}catch{return {text};}
  if(input.action==='read' && parsed.thread?.hostId==='local' && parsed.thread?.kind==='codex') {
    const items=localMessages(input.threadId);
    if(items) return {thread:parsed.thread,turns:[{id:`rollout:${input.threadId}`,items}]};
  }
  if(input.action==='read') return {thread:parsed.thread,turns:(parsed.turns||[]).map(t=>({id:t.id,status:t.status,items:(t.items||[]).flatMap((i,n)=>i.type==='agentMessage'?[{type:i.type,id:i.id,text:i.text,phase:i.phase,complete:n<t.items.length-1||t.status!=='inProgress'}]:[])}))};
  return parsed;
}
module.exports={appRequest,pipeRequest,parseRolloutMessages,findLatestRollout,localMessages};
