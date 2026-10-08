'use strict';
const fs=require('node:fs');
const {splitRoute}=require('./telegram_topics');
const {writeJsonAtomic}=require('./core_utils');
function visibleMessages(snapshot) {
  const out=[];
  for(const turn of [...(snapshot.turns||[])].reverse()) {
    for(const item of turn.items||[]) {
      if(item.type!=='agentMessage'||!item.id||typeof item.text!=='string'||!item.text.trim()||!item.complete)continue;
      out.push({id:`${turn.id}:${item.id}`,text:item.text,phase:item.phase==='commentary'?'commentary':'final_answer'});
    }
  }
  return out;
}
function groupAppThreads(result) {
  const groups=new Map(), seen=new Set();
  const pinned=new Set((result.pinnedThreads||[]).map(x=>`${x.companionId||''}:${x.hostId||'local'}:${x.id}`));
  const projectOrder=(result.sections||[]).flatMap(x=>x.itemKeys||[]).filter(x=>x.startsWith('codex:project:')).map(x=>x.slice('codex:project:'.length));
  for(const row of [...(result.pinnedThreads||[]),...(result.threads||[])]) {
    const identity=`${row.companionId||''}:${row.hostId||'local'}:${row.id}`;
    if(row.kind!=='codex'||seen.has(identity))continue;
    seen.add(identity);
    const cwd=String(row.cwd||'').replace(/\\/g,'/').replace(/\/+$/,'');
    const project=row.projectId || (row.projectId===undefined ? cwd : '');
    const key=JSON.stringify([row.companionId||'',row.hostId||'local',project]);
    if(!groups.has(key))groups.set(key,{projectId:row.projectId,title:project?(cwd||`Projekt ${row.projectId}`):'Ohne Repository / Projekt',host:row.companionLabel || row.companionId || row.hostId || 'local',rows:[]});
    groups.get(key).rows.push({...row,pinned:pinned.has(identity)});
  }
  const ordered=[...groups.values()].sort((a,b)=>{
    const rank=g=>!g.projectId&&g.title==='Ohne Repository / Projekt'?Infinity:projectOrder.includes(g.projectId)?projectOrder.indexOf(g.projectId):projectOrder.length;
    return rank(a)-rank(b);
  });
  const rows=[],sections=[];
  for(const group of ordered){const lines=[`${group.title}${group.host!=='local'?` (${group.host})`:''}`];for(const row of group.rows){rows.push(row);lines.push(`${rows.length}. ${row.pinned?'📌 ':''}${row.title||'(Ohne Titel)'} [${row.status||'unbekannt'}]`);}sections.push(lines.join('\n'));}
  return {rows,text:sections.join('\n\n')};
}

function selectedOutputMode(binding) {
  return ['auto','text','voice','both'].includes(binding.outputMode)?binding.outputMode:binding.voice===false?'text':'auto';
}
function outputMode(binding) {
  const mode=selectedOutputMode(binding);
  return mode==='auto'?(binding.lastInputMode==='voice'?'voice':'text'):mode;
}
const OUTPUT_LABELS={auto:'Wie Eingabe (Text / Stimme)',text:'Nur Text',voice:'Nur Stimme',both:'Text und Stimme'};
function outputKeyboard(binding) {
  return Object.entries(OUTPUT_LABELS).map(([mode,label])=>[{text:`${selectedOutputMode(binding)===mode?'✓ ':''}${label}`,callback_data:`app_output:${binding.bindingId}:${mode}`}]);
}
function topicName(row) {
  const label=row.companionLabel||row.companionId||'Codex';
  return Array.from(`${row.hostId&&row.hostId!=='local'?'🌐 ':''}${row.companionIcon||'💻'} ${label} · ${row.title||'Codex-Chat'}`).slice(0,128).join('');
}
const identity=row=>JSON.stringify([row.companionId||'',row.hostId||'local',row.threadId||row.id]);
function appTitleFromTopic(name,binding) {
  const label=String(binding.companionLabel||binding.companionId||'Codex').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const title=String(name).replace(new RegExp(`^(?:🌐\\s*)?(?:(?:🖥️?|💻)\\s*)?${label}\\s*·\\s*`,'u'),'').trim();
  if(!title)throw Error('App chat title cannot be empty after removing the device prefix.');
  return title;
}
function completePresence(result,row) {
  if((row.hostId||'local')!=='local')return;
  return (result.presence||[]).find(p=>p.complete===true&&p.companionId===row.companionId&&p.hostId==='local'&&Array.isArray(p.ids)&&Array.isArray(p.archivedIds));
}
function createAppChatBridge({filePath,request,sendText,speak,sendScreenshot,createTopic,editTopic,deleteTopic,setTopicClosed,checkTopic,now=Date.now,autoTopicGroup='',syncIntervalMs=10000,onSyncError=()=>{},migrateFromChat="",interruptSpeech,validPreset,voiceChoices=()=>[],speechVersion=()=>0,speechAvailable=()=>true,intervalMs=5000}) {
  let state={};try{state=JSON.parse(fs.readFileSync(filePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  let migratedOutput=false;
  for(const binding of Object.values(state))if(!binding.outputModeVersion){binding.outputMode='auto';binding.outputModeVersion=1;binding.lastInputMode='text';migratedOutput=true;}
  if(migratedOutput)writeJsonAtomic(filePath,state);
  const disabledPath=filePath+'.disabled.json';
  let disabled=[];try{disabled=JSON.parse(fs.readFileSync(disabledPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const pendingPath=filePath+'.pending.json';
  let pending={};try{pending=JSON.parse(fs.readFileSync(pendingPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const lists=new Map(),busy=new Set(),topicSetup=new Set(),catalog=new Map(),lastPoll=new Map();let timer=null,syncTimer=null,stopped=false,polling=false,syncPausedUntil=0;
  const topicGroups=new Map(autoTopicGroup?[[splitRoute(autoTopicGroup).chatId,'']]:[]);
  const save=()=>writeJsonAtomic(filePath,state);
  const target=chat=>state[String(chat)]||null;
  const renaming=new Set();
  async function flushRename(chat,b) {
    const title=b.renamePending;
    if(!title||renaming.has(chat)||now()<(b.renameRetryAt||0))return;
    renaming.add(chat);
    try{
      await request({action:'rename',threadId:b.threadId,hostId:b.hostId,companionId:b.companionId,title});
      if(b.renamePending===title){b.title=title;delete b.renamePending;delete b.renameRetryAt;delete b.renameError;b.renameEchoUntil=now()+30000;}
    }catch(e){if(b.renamePending===title){b.renameError=e.message;b.renameRetryAt=now()+30000;}onSyncError(`App rename: ${e.message}`);}
    finally{renaming.delete(chat);save();}
  }
  async function topicRenamed(chat,name) {
    const b=target(chat);if(!b||!splitRoute(chat).threadId||b.topicDeleted)return false;
    const title=appTitleFromTopic(name,b);
    b.topicName=name;b.renamePending=title;delete b.renameRetryAt;save();
    await flushRename(chat,b);return true;
  }
  const archiving=new Set();
  async function flushArchive(chat,b) {
    if(!b.archivePending||archiving.has(chat)||now()<(b.archiveRetryAt||0))return;
    archiving.add(chat);
    try {
      // Idempotent setter, never a prompt or a new app turn.
      await request({action:'archive',threadId:b.threadId,hostId:b.hostId,companionId:b.companionId});
      delete b.archivePending;delete b.archiveRetryAt;delete b.archiveError;b.archived=true;
    } catch(e){b.archiveError=e.message;b.archiveRetryAt=now()+30000;onSyncError(`App archive: ${e.message}`);}
    finally{archiving.delete(chat);save();}
  }
  async function topicLifecycle(chat,kind) {
    const b=target(chat);if(!b||!splitRoute(chat).threadId||!['closed','deleted'].includes(kind))return false;
    b.topicClosed=true;if(kind==='deleted')b.topicDeleted=true;
    b.archivePending=true;delete b.missingSince;delete b.archiveSince;save();interruptSpeech(chat);
    await flushArchive(chat,b);return true;
  }
  async function checkTopics(group) {
    if(!checkTopic)return;
    const entries=Object.entries(state).filter(([route,b])=>splitRoute(route).chatId===group&&splitRoute(route).threadId&&!b.topicDeleted&&now()-(b.topicCheckedAt||0)>=300000).sort((a,b)=>(a[1].topicCheckedAt||0)-(b[1].topicCheckedAt||0));
    for(const [route,b] of entries.slice(0,2)){
      b.topicCheckedAt=now();
      try{if(await checkTopic(route,b.topicName||topicName(b))===false)await topicLifecycle(route,'deleted');}
      catch(e){onSyncError(`Topic check: ${e.message}`);if(e.retryAfter){syncPausedUntil=Date.now()+e.retryAfter*1000;break;}}
    }
    if(entries.length)save();
  }
  const creation=require('./app_chat_creation').createAppChatCreation({filePath:filePath+'.creation.json',request,sendText,bindCreated:async(chat,row)=>{
    const group=splitRoute(chat).chatId;
    const found=Object.entries(state).find(([route,b])=>splitRoute(route).chatId===group&&splitRoute(route).threadId&&identity(b)===identity(row));
    if(found)return found[0];
    const deadline=Date.now()+60000;
    while(topicSetup.has(group)&&!stopped&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    if(stopped||topicSetup.has(group))throw Error('Topic sync busy. Retry /app new to bind the already-created chat.');
    topicSetup.add(group);
    try{return await bind(group,row,true,{replayNew:true});}finally{topicSetup.delete(group);}
  }});
  async function reconcileDeleted(group,result,rows) {
    const visible=new Set(rows.map(identity));let removed=0;
    for(const [route,b] of Object.entries(state)) {
      if(splitRoute(route).chatId!==group||!splitRoute(route).threadId)continue;
      if(b.renamePending)await flushRename(route,b);
      if(b.archivePending){await flushArchive(route,b);continue;}
      if(/^Telegram sendMessage failed: 400 .*message thread not found/i.test(b.lastError||'')&&!b.topicDeleted){await topicLifecycle(route,'deleted');continue;}
      const presence=completePresence(result,b);
      if(presence)b.archived=presence.archivedIds.includes(b.threadId);
      if(!presence){delete b.archiveSince;delete b.missingSince;continue;}
      if(b.archived){
        delete b.missingSince;
        if(!b.archiveSince)b.archiveSince=now();
        if(setTopicClosed&&!b.topicClosed&&!b.topicDeleted&&now()-b.archiveSince>=10000&&removed<2){
          try{await setTopicClosed(route,true);b.topicClosed=true;removed++;}
          catch(e){onSyncError(`Topic close: ${e.message}`);if(e.retryAfter){syncPausedUntil=Date.now()+e.retryAfter*1000;break;}}
        }
        continue;
      }
      delete b.archiveSince;
      // A deleted topic stays a tombstone until the app is explicitly restored.
      if(b.topicDeleted&&presence.ids.includes(b.threadId)){delete state[route];lastPoll.delete(route);continue;}
      if(b.topicClosed&&presence.ids.includes(b.threadId)&&setTopicClosed){
        try{await setTopicClosed(route,false);b.topicClosed=false;}
        catch(e){onSyncError(`Topic reopen: ${e.message}`);if(e.retryAfter){syncPausedUntil=Date.now()+e.retryAfter*1000;break;}continue;}
      }
      if(!presence||(!b.archived&&(presence.ids.includes(b.threadId)||visible.has(identity(b))))) {
        delete b.missingSince;
        continue;
      }
      if(!b.missingSince){b.missingSince=now();continue;}
      if(!deleteTopic||now()-b.missingSince<10000||removed>=2)continue;
      // Persist the binding until Telegram confirms deletion; failures retry later.
      try {
        await deleteTopic(route);
        delete state[route];lastPoll.delete(route);interruptSpeech(route);removed++;
      } catch(e) {onSyncError(`Topic deletion: ${e.message}`);if(e.retryAfter){syncPausedUntil=Date.now()+e.retryAfter*1000;break;}}
    }
    save();
  }
  async function poll(chat,binding) {
    if(binding.archived||binding.topicClosed||binding.topicDeleted||binding.archivePending||String(chat)===String(migrateFromChat)||busy.has(chat))return;busy.add(chat);
    const audioVersion=speechVersion(chat);
    try {
      if(binding.captionRemainder){
        const pending=binding.captionRemainder;
        if(target(chat)!==binding||stopped)return;
        await sendText(chat,pending.text,{replyToMessageId:pending.messageId});
        delete binding.captionRemainder;save();
      }
      const snap=await request({action:'read',threadId:binding.threadId,hostId:binding.hostId,companionId:binding.companionId});
      if(target(chat)!==binding||stopped)return;
      const seen=new Set(binding.seen||[]);
      for(const msg of visibleMessages(snap)) {
        if(seen.has(msg.id))continue;
        if(target(chat)!==binding||stopped)return;
        const formatted=msg.text;
        const mode=speechAvailable()?outputMode(binding):'text';
        let imageSent=false;
        if(msg.phase==='commentary'&&binding.screenshots!==false&&sendScreenshot){
          const current=()=>target(chat)===binding&&!stopped&&binding.screenshots!==false;
          try{
            const image=await sendScreenshot(chat,binding,current,{text:mode==='voice'?'':formatted});
            imageSent=image?.sent===true;
            if(imageSent&&image.remainder&&current()){
              binding.captionRemainder={text:image.remainder,messageId:image.messageId};save();
              await sendText(chat,image.remainder,{replyToMessageId:image.messageId});
              delete binding.captionRemainder;save();
            }
            binding.lastScreenshotError='';
          }catch(e){
            if(current()&&binding.lastScreenshotError!==e.message){
              binding.lastScreenshotError=e.message;
              await sendText(chat,`Screenshot nicht verfügbar: ${e.message}`).catch(()=>{});
            }
          }
        }
        if(target(chat)!==binding||stopped)return;
        if(mode!=='voice'&&!imageSent)await sendText(chat,formatted);
        if(target(chat)!==binding||stopped)return;
        let queued=false,speechFailed=false;
        if(mode!=='text'&&outputMode(binding)!=='text'&&speechAvailable()){
          try{queued=await speak(chat,msg.text,binding.preset,audioVersion);}
          catch {queued=false;}
          speechFailed=queued===false;
        }
        // A pause can happen during screenshot delivery. A voice-only screenshot
        // has no caption, so text is still required even when that image was sent.
        if(mode==='voice'&&queued===false)await sendText(chat,speechFailed&&speechAvailable()?`Sprachausgabe nicht verfügbar.\n\n${formatted}`:formatted);
        seen.add(msg.id);binding.seen=[...seen].slice(-2000);save();
        if(binding.captionRemainder)return;

      }
      if(binding.lastError||binding.readFailures){binding.lastError='';binding.readFailures=0;save();}
    }catch(e){if(target(chat)===binding){
      binding.lastError=e.message;binding.readFailures=(binding.readFailures||0)+1;
      // Background failures remain visible in /app status without flooding topics.
      // Explicit sends report delivery failures through route().
      save();
    }}
    finally{busy.delete(chat);}
  }
  async function pollAll(){
    if(polling||stopped)return;polling=true;
    try{
      const entries=Object.entries(state).filter(([chat,b])=>{
        const row=catalog.get(identity(b)),last=lastPoll.get(chat);
        return !last||row?.status==='active'||row?.status==='running'||(row&&last.updatedAt!==row.updatedAt)||Date.now()-last.at>=60000;
      });
      const hosts=new Map();for(const entry of entries){const key=entry[1].companionId||'';if(!hosts.has(key))hosts.set(key,[]);hosts.get(key).push(entry);}
      const worker=async queue=>{while(queue.length&&!stopped){const [chat,b]=queue.shift();const updatedAt=catalog.get(identity(b))?.updatedAt;await poll(chat,b);lastPoll.set(chat,{at:Date.now(),updatedAt});}};
      await Promise.all([...hosts.values()].flatMap(queue=>[worker(queue),worker(queue)]));
    }finally{polling=false;}
  }
  async function syncTopics(group=autoTopicGroup,companionId=''){
    group=splitRoute(group).chatId;if(!group||!createTopic||topicSetup.has(group)||stopped||Date.now()<syncPausedUntil)return;
    topicSetup.add(group);
    try{
      const result=await request({action:'list',...(companionId?{companionId}:{})});if(stopped)return;
      if(result.errors?.length)onSyncError(result.errors.join('\n'));
      // Complete local metadata overrides stale sidebar rows for archived chats.
      const rows=groupAppThreads(result).rows.filter(row=>!completePresence(result,row)?.archivedIds.includes(row.id));
      await reconcileDeleted(group,result,rows);
      await checkTopics(group);
      catalog.clear();for(const row of rows)catalog.set(identity(row),row);
      // Keep a recency-ordered creation backlog so newly created chats never wait behind old ones.
      rows.sort((a,b)=>(Number(b.updatedAt)||0)-(Number(a.updatedAt)||0));
      let created=0;
      for(const row of rows){
        if(stopped)break;catalog.set(identity(row),row);
        // Explicit creation owns initial response replay; do not baseline it concurrently.
        if(creation.isCreating(row.companionId))continue;
        if(disabled.includes(`${group}:${identity(row)}`))continue;
        if(pending[`${group}:${identity(row)}`]&&!pending[`${group}:${identity(row)}`].route)continue;
        const found=Object.entries(state).find(([route,b])=>splitRoute(route).threadId&&splitRoute(route).chatId===group&&identity(b)===identity(row));
        try{
          if(found){
            const [route,b]=found,name=topicName(row);
            if(b.archivePending||b.topicDeleted||b.topicClosed)continue;
            if(b.renamePending||(b.renameEchoUntil>now()&&row.title!==b.title))continue;
            delete b.renameEchoUntil;
            if(editTopic&&b.topicName!==name){await editTopic(route,name);b.title=row.title;b.topicName=name;save();}
          }else if(created<2){await bind(group,row,true);created++;}
        }catch(e){onSyncError(`${row.companionLabel||'Codex'}: ${e.message}`);if(e.retryAfter){syncPausedUntil=Date.now()+e.retryAfter*1000;break;}}
      }
      return {created,total:rows.length};
    }catch(e){onSyncError(e.message);}finally{topicSetup.delete(group);}
  }
  function start(){stopped=false;if(timer)return;timer=setInterval(()=>{void pollAll().catch(error=>onSyncError(error.message));},intervalMs);timer.unref?.();const sync=()=>{for(const [group,host] of topicGroups)void syncTopics(group,host).catch(error=>onSyncError(error.message));};sync();syncTimer=setInterval(sync,syncIntervalMs);syncTimer.unref?.();}
  function stop(){stopped=true;clearInterval(timer);clearInterval(syncTimer);timer=null;syncTimer=null;}
  async function bind(chat,row,makeTopic=false,{replayNew=false}={}) {
      const snap=await request({action:'read',threadId:row.id,hostId:row.hostId,companionId:row.companionId});
      // Baseline every existing message, including one currently streaming.
      const seen=replayNew?[]:(snap.turns||[]).flatMap(t=>(t.items||[]).filter(i=>i.type==='agentMessage').map(i=>`${t.id}:${i.id}`));
      if(makeTopic) {
        const key=`${splitRoute(chat).chatId}:${identity(row)}`;
        if(pending[key]?.route)chat=pending[key].route;
        else {
          if(pending[key])throw new Error('Vorherige Themenanlage unbestätigt. Vor Wiederholung Telegram prüfen.');
          pending[key]={title:topicName(row),startedAt:Date.now()};writeJsonAtomic(pendingPath,pending);
          try{chat=await createTopic(chat,topicName(row),{iconColor:row.companionIcon==='🖥️'?0x6FB9F0:0xCB86DB});}
          catch(e){if(e.deliveryRejected){delete pending[key];writeJsonAtomic(pendingPath,pending);}throw e;}
          pending[key].route=chat;
          try{writeJsonAtomic(pendingPath,pending);}
          catch(e){if(deleteTopic){await deleteTopic(chat);delete pending[key];}throw e;}
        }
      }
      const legacy=makeTopic?target(migrateFromChat):null;
      const migrate=legacy&&legacy.threadId===row.id&&(legacy.hostId||'local')===(row.hostId||'local')&&(!legacy.companionId||legacy.companionId===row.companionId);
      const preferences=migrate?{preset:legacy.preset,voice:legacy.voice,outputMode:selectedOutputMode(legacy),lastInputMode:legacy.lastInputMode,screenshots:legacy.screenshots}:{};
      if(migrate){delete state[String(migrateFromChat)];interruptSpeech(migrateFromChat);}
      state[String(chat)]={threadId:row.id,hostId:row.hostId,companionId:row.companionId,companionLabel:row.companionLabel,title:row.title,topicName:makeTopic?topicName(row):undefined,screenshots:false,preset:'starship-comms',voice:true,outputMode:'auto',outputModeVersion:1,lastInputMode:'text',...preferences,seen:seen.slice(-2000),bindingId:require('node:crypto').randomUUID()};save();interruptSpeech(chat);
      if(makeTopic){delete pending[`${splitRoute(chat).chatId}:${identity(row)}`];writeJsonAtomic(pendingPath,pending);}
      disabled=disabled.filter(x=>x!==`${splitRoute(chat).chatId}:${identity(row)}`);writeJsonAtomic(disabledPath,disabled);
      return chat;
  }
  async function command(chat,arg='') {
    const [action='',value='']=arg.trim().split(/\s+/);
    if(action==='topics'||action==='topic') {
      if(!createTopic||!splitRoute(chat).chatId.startsWith('-'))throw new Error('Bitte /app topics in der Telegram-Themengruppe verwenden.');
      const group=splitRoute(chat).chatId;
      if(topicSetup.has(group))throw new Error('Themen werden bereits angelegt. Bitte warten.');
      if(action==='topics'){
        topicGroups.set(group,value);
        const result=await syncTopics(group,value);
        await sendText(chat,`App-Themen-Abgleich aktiv. ${result?.created||0} neue Themen angelegt; weitere folgen gedrosselt im Hintergrund. Dauerhaft nach Neustarts: APP_TOPIC_GROUP_ID konfigurieren.`);
        return;
      }
      topicSetup.add(group);
      try {
      let rows;
      if(action==='topic') {
        const row=(lists.get(String(chat))||[])[Number(value)-1];
        if(!row)throw new Error('Zuerst /app list, dann /app topic <Nummer>.');
        rows=[row];
      } else {
        const result=await request({action:'list',...(value?{companionId:value}:{})});
        rows=groupAppThreads(result).rows;
        if(result.errors?.length)await sendText(chat,result.errors.join('\n'));
      }
      let created=0,existing=0;
      for(const row of rows) {
        const found=Object.entries(state).some(([route,b])=>splitRoute(route).threadId&&splitRoute(route).chatId===splitRoute(chat).chatId&&b.threadId===row.id&&(b.hostId||'local')===(row.hostId||'local')&&(b.companionId||'')===(row.companionId||''));
        if(found){existing++;continue;}
        await bind(chat,row,true);created++;
      }
      await sendText(chat,`${created} Codex-Themen angelegt, ${existing} bereits verbunden. Allgemein bleibt der Hauptchat. Stimme und Ausgabe lassen sich in jedem Thema mit /app voice und /app output ändern.`);return;
      } finally {topicSetup.delete(group);}
    }
    if(action==='hosts'){const result=await request({action:'hosts'});await sendText(chat,result.hosts.map(h=>`${h.id}: ${h.label}`).join('\n')+'\n/app list <Host-ID>');return;}
    if(!action||action==='list'){
      const result=await request({action:'list',...(value?{companionId:value}:{})});const {rows,text}=groupAppThreads(result);
      await sendText(chat,rows.length?text+'\n\n/app use <Nummer> verbindet den Chat. /app topic <Nummer> legt dafür ein eigenes Gruppenthema an. /app topics erstellt Themen für alle gelisteten App-Chats. /app output wählt Text/Stimme/beides. /app voice zeigt die Stimmenauswahl. /app off trennt ihn.':'Keine Codex-Chats gefunden.');if(result.errors?.length)await sendText(chat,result.errors.join('\n'));lists.set(String(chat),rows);return;
    }
    if(action==='off'){const b=target(chat);if(b){disabled.push(`${splitRoute(chat).chatId}:${identity(b)}`);writeJsonAtomic(disabledPath,[...new Set(disabled)]);}delete state[String(chat)];save();interruptSpeech(chat);await sendText(chat,'App-Chat getrennt. Seine Arbeit läuft weiter. Automatisches Wiederanlegen für diesen Chat deaktiviert.');return;}
    if(action==='status'){const b=target(chat);await sendText(chat,b?`Verbunden: ${b.title}\nAusgabe: ${OUTPUT_LABELS[selectedOutputMode(b)]}\nScreenshots: ${b.screenshots===false?'aus':'an'}\nStimme: ${outputMode(b)==='text'?'aus':b.preset}\n${b.lastError||'Lesen und Folgeeingaben über die Codex-App.'}`:'Kein App-Chat verbunden. /app list');return;}
    if(action==='use'){
      const rows=lists.get(String(chat))||[];const row=rows[Number(value)-1];if(!row)throw new Error('Zuerst /app list, dann /app use <Nummer>.');
      await bind(chat,row);
      await sendText(chat,`Verbunden mit ${row.companionLabel||'Codex-App'}: ${row.title}\nText und Sprachnachrichten gehen jetzt an diesen App-Chat. Antworten folgen deiner Eingabe: Text auf Text, Stimme auf Voice. /app output ändert den Ausgabemodus. /app voice wählt das Stimmprofil; /app off trennt die Verbindung.`);return;
    }
    if(action==='screenshots'){
      const b=target(chat);if(!b)throw new Error('Zuerst einen App-Chat verbinden.');
      if(value&&!['on','off'].includes(value))throw new Error('/app screenshots on | off');
      if(value){b.screenshots=value==='on';save();}
      await sendText(chat,`Screenshots bei Zwischenständen: ${b.screenshots===false?'aus':'an'}. /app screenshots on | off`);return;
    }
    if(action==='output'||action==='mode') {
      const b=target(chat);if(!b)throw new Error('Zuerst einen App-Chat verbinden.');
      if(!value||value==='list'){
        await sendText(chat,`Ausgabe · ${b.title}\nAktuell: ${OUTPUT_LABELS[selectedOutputMode(b)]}\nGilt für Zwischenantworten und finale Antworten.`,{replyMarkup:{inline_keyboard:outputKeyboard(b)}});return;
      }
      const mode=({auto:'auto',text:'text',voice:'voice',stimme:'voice',both:'both',beides:'both'})[value];
      if(!mode)throw new Error('/app output auto | text | voice | both');
      b.outputMode=mode;b.voice=mode!=='text';save();interruptSpeech(chat);
      await sendText(chat,`Ausgabe: ${OUTPUT_LABELS[mode]}`);return;
    }
    if(action==='voice') {
      const b=target(chat);if(!b)throw new Error('Zuerst einen App-Chat verbinden.');
      const choices=voiceChoices();
      if(!value||value==='list'){
        const current=b.voice===false?'Stumm':b.preset;
        await sendText(chat,`Stimme für App-Antworten · ${b.title}\nAktuell: ${current}\n\n${choices.map(x=>`${x.label}: ${x.description}`).join('\n')}\n\nDas Profil gilt für Zwischenstände und finale Antworten, auch bei mehreren Sprachnachrichten.`,{
          replyMarkup:{inline_keyboard:[...choices.map(x=>[{text:`${b.voice!==false&&b.preset===x.id?'✓ ':''}${x.label}`,callback_data:`app_voice:${b.bindingId}:${x.id}`}]),[{text:'Stumm',callback_data:`app_voice:${b.bindingId}:mute`}],...outputKeyboard(b)]},
        });return;
      }
      if(value==='mute'){b.voice=false;b.outputMode='text';}
      else {if(!validPreset(value))throw new Error('Unbekannte Stimme. /app voice zeigt die Auswahl.');b.preset=value;b.voice=true;}
      save();interruptSpeech(chat);await sendText(chat,`Zwischenantworten: ${b.voice===false?'Stumm':b.preset}`);return;
    }
    throw new Error('/app new | list | use <Nummer> | status | output <auto|text|voice|both> | voice <Preset|mute> | off');
  }
  async function route(chat,text,expected=target(chat),{inputMode='text',attachments,deliveryId}={}) {
    if(!expected)return false;
    const b=target(chat);if(!b||b.bindingId!==expected.bindingId){await sendText(chat,'App-Verbindung wurde während der Verarbeitung geändert. Bitte Nachricht erneut senden.');return true;}
    if(b.archived||b.topicClosed||b.topicDeleted||b.archivePending)return true;
    b.lastInputMode=inputMode==='voice'?'voice':'text';save();interruptSpeech(chat);
    try{await request({action:'send',threadId:b.threadId,hostId:b.hostId,companionId:b.companionId,text,...(attachments?.length?{attachments,deliveryId}:{})});if(inputMode!=='voice'&&attachments?.length)await sendText(chat,'Datei im Codex-App-Chat verfügbar.');}
    catch(e){await sendText(chat,`App-Nachricht nicht bestätigt: ${e.message}\nNicht automatisch erneut gesendet. Bitte zuerst den App-Chat prüfen.`);}
    return true;
  }
  return {command,route,target,start,stop,poll,pollAll,syncTopics,creation,topicLifecycle,topicRenamed};
}
module.exports={createAppChatBridge,visibleMessages,groupAppThreads,appTitleFromTopic};
