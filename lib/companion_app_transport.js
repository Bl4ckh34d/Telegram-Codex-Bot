'use strict';
const {loadCompanionHosts}=require('./companion_hosts');
const {spawn,terminateChildTree}=require('./process_lifecycle');
function createAppTransport(configPath, {spawnProcess=spawn, maxConcurrentPerHost=2, now=Date.now, localRequest=require('../companion/app-bridge').appRequest} = {}) {
  const lanes=new Map();
  const limit=Math.max(1,Math.min(4,Number(maxConcurrentPerHost)||2));
  function schedule(config,input,{interactive=['send','create','projects'].includes(input.action)}={}) {
    const key=JSON.stringify([config.transport,config.destination,config.ssh_args||[]]);
    let lane=lanes.get(key);
    if(!lane){lane={active:0,queue:[],failures:0,retryAt:0,epoch:0,probing:false};lanes.set(key,lane);}
    const offlineError=()=>Object.assign(new Error(`Gerät derzeit nicht erreichbar. Anfrage nicht gesendet; nächste Hintergrundprüfung in ${Math.ceil(Math.max(0,lane.retryAt-now())/1000)} Sekunden.`),{code:'DEVICE_OFFLINE',retryAfterMs:Math.max(0,lane.retryAt-now())});
    return new Promise((resolve,reject)=>{
      if(lane.failures&&(lane.probing||(!interactive&&now()<lane.retryAt))){reject(offlineError());return;}
      if(lane.queue.length>=128){reject(new Error('Companion-Warteschlange voll. Bitte kurz warten.'));return;}
      const task={input,resolve,reject,interactive};
      // Interactive input goes ahead of background reads, without duplicating sends.
      if(interactive){const index=lane.queue.findIndex(x=>!x.interactive);lane.queue.splice(index<0?lane.queue.length:index,0,task);}else lane.queue.push(task);
      function drain(){
        while(lane.active<limit&&lane.queue.length){
          const next=lane.queue[0];
          if(lane.failures&&(lane.probing||(!next.interactive&&now()<lane.retryAt))){lane.queue.shift().reject(offlineError());continue;}
          if(lane.failures&&lane.active)return;
          const job=lane.queue.shift(),epoch=lane.epoch,probe=lane.failures>0;lane.active++;if(probe)lane.probing=true;
          const reachable=()=>{if(epoch===lane.epoch&&lane.failures){lane.failures=0;lane.retryAt=0;lane.epoch++;}};
          Promise.resolve().then(()=>config.transport==='local'?localRequest(job.input,config):single(config,job.input)).then(value=>{reachable();job.resolve(value);},error=>{
            if(error.deviceUnavailable&&epoch===lane.epoch){lane.failures++;lane.retryAt=now()+Math.min(600000,30000*2**Math.min(lane.failures-1,5));lane.epoch++;}
            else if(!error.deviceUnavailable)reachable();
            job.reject(error);
          }).finally(()=>{lane.active--;if(probe)lane.probing=false;drain();});
        }
      }
      drain();
    });
  }
  const single=(config,input)=>new Promise((resolve,reject)=>{
    const child=spawnProcess('ssh',[...(config.ssh_args||[]),config.destination,config.remote_command],{stdio:['pipe','pipe','pipe']});
    let out='',stderr='',done=false;
    const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(value);};
    const timer=setTimeout(()=>{void terminateChildTree(child);finish(Object.assign(new Error('Codex app request timed out; delivery unknown. Check the app before resending.'),{deviceUnavailable:true}));},45000);
    child.on('error',e=>finish(Object.assign(e,{deviceUnavailable:true})));child.stdin.on('error',()=>{});child.stderr.on('data',data=>{stderr=(stderr+data).slice(-8192);});
    child.stdout.on('data',data=>{out+=data;if(out.length>(input.action==='screenshot'?24:8)*1024*1024){void terminateChildTree(child);finish(new Error('App response too large'));}});
    child.on('close',code=>{if(code!==0){
      const reason=/MaxStartups|kex_exchange_identification|Connection reset|Connection closed/i.test(stderr)?'SSH-Verbindung wurde abgewiesen oder unterbrochen':/Permission denied/i.test(stderr)?'SSH-Anmeldung fehlgeschlagen':/ENOENT|no rollout|thread.*not found/i.test(stderr)?'Codex-Chat auf dem Companion nicht verfügbar':'Companion-Abfrage fehlgeschlagen';
      return finish(Object.assign(new Error(`${reason} (Exit ${code}).${['send','create'].includes(input.action)?' Zustellung unklar; vor erneutem Senden in der App prüfen.':input.action==='projects'?' Gerät/App prüfen und erneut auswählen.':' Lesen wird automatisch erneut versucht.'}`),{deviceUnavailable:code===255}));
    }try{const r=JSON.parse(out);if(r.error)throw new Error(r.error);finish(null,r.result);}catch(e){finish(e);}});
    child.stdin.end(JSON.stringify(input.action==='screenshot'?{method:'ui',input:{action:'screenshot'}}:{method:'app',input}));
  });
  return async input=>{
    const hosts=loadCompanionHosts(configPath);
    if(input.action==='hosts')return {hosts:hosts.list()};
    if(input.action==='list'){
      const selected=input.companionId?[hosts.get(input.companionId)]:hosts.list().map(h=>hosts.get(h.id));
      const results=await Promise.all(selected.map(async host=>{
        try{return {host,result:await schedule(host.config,input)};}catch(error){return {host,error:error.message};}
      }));
      const merged={threads:[],pinnedThreads:[],sections:[],errors:[],presence:[]};
      for(const {host,result,error} of results){
        if(error){merged.errors.push(`${host.label}: ${error}`);continue;}
        for(const key of ['threads','pinnedThreads'])merged[key].push(...(result[key]||[]).map(row=>({...row,companionId:host.id,companionLabel:host.label,companionIcon:host.icon})));
        merged.errors.push(...(result.errors||[]).map(error=>`${host.label}: ${error}`));
        merged.sections.push(...(result.sections||[]));
        if(!result.errors?.length&&result.localPresence?.complete===true)merged.presence.push({...result.localPresence,companionId:host.id});
      }
      return merged;
    }
    const host=hosts.get(input.companionId);
    if(input.action==='send'&&input.attachments?.length){
      let capability;
      try{capability=await schedule(host.config,{action:'capabilities'},{interactive:true});}catch{throw new Error('Dateiübertragung nicht verfügbar. Companion aktualisieren und Geräteverbindung prüfen.');}
      if(capability?.attachments!==1)throw new Error('Companion unterstützt keine Dateiübertragung. Bitte aktualisieren.');
    }
    const result=await schedule(host.config,input);
    if(input.action==='create')return {...result,companionId:host.id,companionLabel:host.label,companionIcon:host.icon};
    return result;
  };
}
module.exports={createAppTransport};
