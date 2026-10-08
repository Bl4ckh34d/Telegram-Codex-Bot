'use strict';

function createTtsResourcePolicy({idleMs=60000,paused=false,now=Date.now,unload,preload,save}) {
  let active=0,lastActivity=now(),dirty=false,unloading=false,revision=0,commands=Promise.resolve();
  const touch=()=>{lastActivity=now();revision++;};
  const status=()=>({paused,idleMs,active,lastActivity});
  return {
    available:()=>!paused,
    status,
    touch,
    begin(){if(paused)throw Error('TTS paused for GPU work');active++;dirty=true;touch();},
    end(){active=Math.max(0,active-1);touch();},
    async tick(){
      if(paused||!idleMs||active||!dirty||unloading||now()-lastActivity<idleMs)return;
      const stamp=revision;
      const shouldUnload=()=>!active&&revision===stamp&&now()-lastActivity>=idleMs;
      unloading=true;
      try{await unload({shouldUnload,stop:false});if(shouldUnload())dirty=false;}
      finally{unloading=false;}
    },
    command(action){
      const run=async()=>{
        if(action==='status')return status();
        if(!['pause','resume'].includes(action))throw Error('Use pause, resume or status');
        const next=action==='pause';
        save({paused:next});paused=next;touch();
        if(paused){await unload({shouldUnload:()=>paused,stop:true});dirty=false;}
        else {active++;try{await preload();dirty=true;}finally{active--;touch();}}
        return status();
      };
      const result=commands.then(run);commands=result.catch(()=>{});return result;
    },
  };
}
module.exports={createTtsResourcePolicy};
