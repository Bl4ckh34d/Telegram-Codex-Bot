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

function outputMode(binding) {
  return ['text','voice','both'].includes(binding.outputMode)?binding.outputMode:binding.voice===false?'text':'both';
}
const OUTPUT_LABELS={text:'Nur Text',voice:'Nur Stimme',both:'Text und Stimme'};
function outputKeyboard(binding) {
  return Object.entries(OUTPUT_LABELS).map(([mode,label])=>[{text:`${outputMode(binding)===mode?'✓ ':''}${label}`,callback_data:`app_output:${binding.bindingId}:${mode}`}]);
}
function createAppChatBridge({filePath,request,sendText,speak,sendScreenshot,createTopic,migrateFromChat="",interruptSpeech,validPreset,voiceChoices=()=>[],speechVersion=()=>0,intervalMs=5000}) {
  let state={};try{state=JSON.parse(fs.readFileSync(filePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const lists=new Map(),busy=new Set(),topicSetup=new Set();let timer=null,stopped=false;
  const save=()=>writeJsonAtomic(filePath,state);
  const target=chat=>state[String(chat)]||null;
  async function poll(chat,binding) {
    if(String(chat)===String(migrateFromChat)||busy.has(chat))return;busy.add(chat);
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
        const mode=outputMode(binding);
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
        if(mode!=='text'&&outputMode(binding)!=='text'){
          let queued=false;
          try{queued=await speak(chat,msg.text,binding.preset,audioVersion);}
          catch {queued=false;}
          // Keep the response accessible if speech could not even be queued.
          if(queued===false&&mode==='voice')await sendText(chat,`Sprachausgabe nicht verfügbar.\n\n${formatted}`);
        }
        seen.add(msg.id);binding.seen=[...seen].slice(-2000);save();
        if(binding.captionRemainder)return;

      }
      if(binding.lastError||binding.readFailures){binding.lastError='';binding.readFailures=0;save();}
    }catch(e){if(target(chat)===binding){
      binding.lastError=e.message;binding.readFailures=(binding.readFailures||0)+1;
      // A single rejected read is retried by polling; flapping must not flood topics.
      const now=Date.now();
      const notify=binding.readFailures>=3&&now-(binding.lastConnectionNoticeAt||0)>=300000;
      if(notify)binding.lastConnectionNoticeAt=now;
      save();
      if(notify)await sendText(chat,`Companion-Verbindung: ${e.message}`).catch(()=>{});
    }}
    finally{busy.delete(chat);}
  }
  function start(){stopped=false;if(timer)return;timer=setInterval(()=>{for(const [chat,b] of Object.entries(state))void poll(chat,b);},intervalMs);timer.unref?.();}
  function stop(){stopped=true;clearInterval(timer);timer=null;}
  async function bind(chat,row,makeTopic=false) {
      const snap=await request({action:'read',threadId:row.id,hostId:row.hostId,companionId:row.companionId});
      // Baseline every existing message, including one currently streaming.
      const seen=(snap.turns||[]).flatMap(t=>(t.items||[]).filter(i=>i.type==='agentMessage').map(i=>`${t.id}:${i.id}`));
      if(makeTopic) {
        const cwd=String(row.cwd||'').replace(/\\/g,'/').split('/').filter(Boolean).pop();
        chat=await createTopic(chat,`${cwd?cwd+' · ':''}${row.title||'Codex-Chat'}`);
      }
      const legacy=makeTopic?target(migrateFromChat):null;
      const migrate=legacy&&legacy.threadId===row.id&&(legacy.hostId||'local')===(row.hostId||'local')&&(!legacy.companionId||legacy.companionId===row.companionId);
      const preferences=migrate?{preset:legacy.preset,voice:legacy.voice,outputMode:outputMode(legacy),screenshots:legacy.screenshots}:{};
      if(migrate){delete state[String(migrateFromChat)];interruptSpeech(migrateFromChat);}
      state[String(chat)]={threadId:row.id,hostId:row.hostId,companionId:row.companionId,companionLabel:row.companionLabel,title:row.title,preset:'starship-comms',voice:true,outputMode:'both',...preferences,seen:seen.slice(-2000),bindingId:require('node:crypto').randomUUID()};save();interruptSpeech(chat);
      return chat;
  }
  async function command(chat,arg='') {
    const [action='',value='']=arg.trim().split(/\s+/);
    if(action==='topics'||action==='topic') {
      if(!createTopic||!splitRoute(chat).chatId.startsWith('-'))throw new Error('Bitte /app topics in der Telegram-Themengruppe verwenden.');
      const group=splitRoute(chat).chatId;
      if(topicSetup.has(group))throw new Error('Themen werden bereits angelegt. Bitte warten.');
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
    if(action==='off'){delete state[String(chat)];save();interruptSpeech(chat);await sendText(chat,'App-Chat getrennt. Seine Arbeit läuft weiter.');return;}
    if(action==='status'){const b=target(chat);await sendText(chat,b?`Verbunden: ${b.title}\nAusgabe: ${OUTPUT_LABELS[outputMode(b)]}\nScreenshots: ${b.screenshots===false?'aus':'an'}\nStimme: ${outputMode(b)==='text'?'aus':b.preset}\n${b.lastError||'Lesen und Folgeeingaben über die Codex-App.'}`:'Kein App-Chat verbunden. /app list');return;}
    if(action==='use'){
      const rows=lists.get(String(chat))||[];const row=rows[Number(value)-1];if(!row)throw new Error('Zuerst /app list, dann /app use <Nummer>.');
      await bind(chat,row);
      await sendText(chat,`Verbunden mit ${row.companionLabel||'Codex-App'}: ${row.title}\nText und Sprachnachrichten gehen jetzt an diesen App-Chat. Neue Zwischenstände werden vorgelesen. /app output wählt Text, Stimme oder beides. /app voice wählt das Stimmprofil; /app off trennt die Verbindung.`);return;
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
        await sendText(chat,`Ausgabe · ${b.title}\nAktuell: ${OUTPUT_LABELS[outputMode(b)]}\nGilt für Zwischenantworten und finale Antworten.`,{replyMarkup:{inline_keyboard:outputKeyboard(b)}});return;
      }
      const mode=({text:'text',voice:'voice',stimme:'voice',both:'both',beides:'both'})[value];
      if(!mode)throw new Error('/app output text | voice | both');
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
      else {if(!validPreset(value))throw new Error('Unbekannte Stimme. /app voice zeigt die Auswahl.');b.preset=value;b.outputMode=outputMode(b)==='voice'?'voice':'both';b.voice=true;}
      save();interruptSpeech(chat);await sendText(chat,`Zwischenantworten: ${b.voice===false?'Stumm':b.preset}`);return;
    }
    throw new Error('/app list | use <Nummer> | status | output <text|voice|both> | voice <Preset|mute> | off');
  }
  async function route(chat,text,expected=target(chat)) {
    if(!expected)return false;
    const b=target(chat);if(!b||b.bindingId!==expected.bindingId){await sendText(chat,'App-Verbindung wurde während der Verarbeitung geändert. Bitte Nachricht erneut senden.');return true;}
    try{await request({action:'send',threadId:b.threadId,hostId:b.hostId,companionId:b.companionId,text});await sendText(chat,'An die Codex-App gesendet.');}
    catch(e){await sendText(chat,`App-Nachricht nicht bestätigt: ${e.message}\nNicht automatisch erneut gesendet. Bitte zuerst den App-Chat prüfen.`);}
    return true;
  }
  return {command,route,target,start,stop,poll};
}
module.exports={createAppChatBridge,visibleMessages,groupAppThreads};
