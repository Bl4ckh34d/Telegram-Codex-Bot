'use strict';
const {loadCompanionHosts}=require('./companion_hosts');
const {spawn,terminateChildTree}=require('./process_lifecycle');
function createAppTransport(configPath, {spawnProcess=spawn, maxConcurrentPerHost=2} = {}) {
  const lanes=new Map();
  const limit=Math.max(1,Math.min(4,Number(maxConcurrentPerHost)||2));
  function schedule(config,input) {
    const key=JSON.stringify([config.destination,config.ssh_args||[]]);
    let lane=lanes.get(key);
    if(!lane){lane={active:0,queue:[]};lanes.set(key,lane);}
    return new Promise((resolve,reject)=>{
      if(lane.queue.length>=128){reject(new Error('Companion-Warteschlange voll. Bitte kurz warten.'));return;}
      const task={input,resolve,reject};
      // Interactive input goes ahead of background reads, without duplicating sends.
      if(input.action==='send'){const index=lane.queue.findIndex(x=>x.input.action!=='send');lane.queue.splice(index<0?lane.queue.length:index,0,task);}else lane.queue.push(task);
      function drain(){
        while(lane.active<limit&&lane.queue.length){
          const job=lane.queue.shift();lane.active++;
          Promise.resolve().then(()=>single(config,job.input)).then(job.resolve,job.reject).finally(()=>{lane.active--;drain();});
        }
      }
      drain();
    });
  }
  const single=(config,input)=>new Promise((resolve,reject)=>{
    const child=spawnProcess('ssh',[...(config.ssh_args||[]),config.destination,config.remote_command],{stdio:['pipe','pipe','pipe']});
    let out='',stderr='',done=false;
    const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(value);};
    const timer=setTimeout(()=>{void terminateChildTree(child);finish(new Error('Codex app request timed out; delivery unknown. Check the app before resending.'));},45000);
    child.on('error',e=>finish(e));child.stdin.on('error',()=>{});child.stderr.on('data',data=>{stderr=(stderr+data).slice(-8192);});
    child.stdout.on('data',data=>{out+=data;if(out.length>(input.action==='screenshot'?24:8)*1024*1024){void terminateChildTree(child);finish(new Error('App response too large'));}});
    child.on('close',code=>{if(code!==0){
      const reason=/MaxStartups|kex_exchange_identification|Connection reset|Connection closed/i.test(stderr)?'SSH-Verbindung wurde abgewiesen oder unterbrochen':/Permission denied/i.test(stderr)?'SSH-Anmeldung fehlgeschlagen':/ENOENT|no rollout|thread.*not found/i.test(stderr)?'Codex-Chat auf dem Companion nicht verfügbar':'Companion-Abfrage fehlgeschlagen';
      return finish(new Error(`${reason} (Exit ${code}).${input.action==='send'?' Zustellung unklar; vor erneutem Senden in der App prüfen.':' Lesen wird automatisch erneut versucht.'}`));
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
      const merged={threads:[],pinnedThreads:[],sections:[],errors:[]};
      for(const {host,result,error} of results){
        if(error){merged.errors.push(`${host.label}: ${error}`);continue;}
        for(const key of ['threads','pinnedThreads'])merged[key].push(...(result[key]||[]).map(row=>({...row,companionId:host.id,companionLabel:host.label})));
        merged.sections.push(...(result.sections||[]));
      }
      return merged;
    }
    const host=hosts.get(input.companionId);
    return schedule(host.config,input);
  };
}
module.exports={createAppTransport};
