'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {writeJsonAtomic}=require('./core_utils');

function createAppChatCreation({filePath,request,sendText,bindCreated,now=Date.now}) {
  let sessions={};try{sessions=JSON.parse(fs.readFileSync(filePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const locks=new Set(),save=()=>writeJsonAtomic(filePath,sessions),key=(chat,user)=>`${chat}:${user}`;
  const messageId=result=>Number((Array.isArray(result)?result[0]:result)?.message_id)||0;
  const button=(s,text,action,index='')=>({text,callback_data:`app_new:${s.id}:${action}:${index}`});
  async function showProjects(chat,s,page=0) {
    s.phase='project';s.page=Math.max(0,page);save();
    const rows=s.projects.map((p,i)=>({...p,index:i})).filter(p=>!s.search||String(p.label).toLowerCase().includes(s.search.toLowerCase()));
    const start=s.page*8;
    const keyboard=[[button(s,'No repository','project','none')],...rows.slice(start,start+8).map(p=>[button(s,p.label||p.projectId,'project',p.index)])];
    const nav=[];if(start>0)nav.push(button(s,'Previous','page',s.page-1));if(start+8<rows.length)nav.push(button(s,'Next','page',s.page+1));if(nav.length)keyboard.push(nav);
    keyboard.push([button(s,'Search projects','search'),button(s,'Cancel','cancel')]);
    await sendText(chat,`Choose a project on ${s.device.label}${s.search?` (search: ${s.search})`:''}:`,{replyMarkup:{inline_keyboard:keyboard}});
  }
  async function finish(chat,s) {
    const r=s.result;
    if(!r?.threadId||!r.hostId){s.phase='uncertain';save();throw Error('App creation pending or unconfirmed. Check the app; no topic was created.');}
    const route=await bindCreated(chat,{...r,id:r.threadId,kind:'codex',title:r.title||s.title});
    s.phase='done';s.route=route;save();
    await sendText(chat,`Created on ${s.device.label}. Open the new topic to continue.`);
  }
  async function begin(chat,user) {
    if(!String(chat).split('~')[0].startsWith('-'))throw Error('Use /app new in the Telegram topic group.');
    const k=key(chat,user),old=sessions[k];
    if(locks.has(k)||['creating','uncertain'].includes(old?.phase))throw Error('Previous creation is unconfirmed. Check the app before another attempt.');
    if(old?.phase==='created'){await finish(chat,old);return;}
    const {hosts}=await request({action:'hosts'});
    const s={id:crypto.randomUUID().slice(0,16),requestId:crypto.randomUUID(),phase:'device',user:String(user),chat:String(chat),hosts,at:now()};sessions[k]=s;save();
    await sendText(chat,'New Codex chat — choose device:',{replyMarkup:{inline_keyboard:[...hosts.map((h,i)=>[button(s,h.label,'device',i)]),[button(s,'Cancel','cancel')]]}});
  }
  async function callback(chat,user,data) {
    const [,id,action,index]=String(data).split(':'),k=key(chat,user),s=sessions[k];
    if(!s||s.id!==id||now()-s.at>30*60*1000)throw Error('Menu expired or belongs to another owner. Open /app new.');
    if(locks.has(k))return;
    if(['creating','uncertain','created','done'].includes(s.phase))throw Error('Creation already submitted. Check the app or use /app new for status.');
    locks.add(k);
    try {
      if(action==='cancel'){delete sessions[k];save();await sendText(chat,'Chat creation canceled.');return;}
      if(action==='device'&&s.phase==='device') {
        const device=s.hosts[Number(index)];if(!device)throw Error('Unknown device.');
        const result=await request({action:'projects',companionId:device.id});
        if(!Array.isArray(result.projects))throw Error('Device project catalog unavailable.');
        s.device=device;s.projects=result.projects;s.search='';await showProjects(chat,s);return;
      }
      if(action==='page'&&s.phase==='project'){await showProjects(chat,s,Number(index)||0);return;}
      if(action==='search'&&s.phase==='project') {
        const msg=await sendText(chat,'Reply to this message with a project search term (or * for all).',{replyMarkup:{force_reply:true,selective:true}});
        if(!messageId(msg))throw Error('Prompt delivery unconfirmed.');s.phase='search';s.replyId=messageId(msg);save();return;
      }
      if(action==='project'&&s.phase==='project') {
        const project=index==='none'?null:s.projects[Number(index)];if(index!=='none'&&!project)throw Error('Unknown project.');
        const msg=await sendText(chat,`Reply to this message with the first message for your new chat on ${s.device.label} (${project?.label||'No repository'}).`,{replyMarkup:{force_reply:true,selective:true}});
        if(!messageId(msg))throw Error('Prompt delivery unconfirmed.');s.projectId=project?.projectId||null;s.phase='prompt';s.replyId=messageId(msg);save();return;
      }
      throw Error('Menu expired. Open /app new.');
    } finally {locks.delete(k);}
  }
  async function text(chat,user,text,replyId) {
    const k=key(chat,user),s=sessions[k];if(!s||!replyId||Number(s.replyId)!==Number(replyId))return false;
    if(locks.has(k)||!['search','prompt'].includes(s.phase))return true;
    locks.add(k);
    try {
      if(now()-s.at>30*60*1000)throw Error('Menu expired. Open /app new.');
      if(s.phase==='search'){s.search=text.trim()==='*'?'':text.trim();await showProjects(chat,s);return true;}
      if(!text.trim()||text.length>30000)throw Error('Initial message must contain 1–30000 characters.');
      s.title=text.trim().split(/\r?\n/)[0].slice(0,80);s.phase='creating';save();
      try{s.result=await request({action:'create',companionId:s.device.id,requestId:s.requestId,projectId:s.projectId,text,title:s.title});}
      catch(e){s.phase='uncertain';save();throw e;}
      s.phase='created';save();await finish(chat,s);
    } catch(e) {await sendText(chat,`Chat creation: ${e.message}. No creation request was retried. Use /app new to retry topic binding after a confirmed app creation.`);}
    finally{locks.delete(k);}
    return true;
  }
  const isCreating=companionId=>Object.values(sessions).some(s=>s.device?.id===companionId&&['creating','created'].includes(s.phase));
  return {begin,callback,text,isCreating};
}
module.exports={createAppChatCreation};
