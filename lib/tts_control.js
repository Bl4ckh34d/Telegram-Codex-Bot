'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {writeJsonAtomic}=require('./core_utils');
const valid=/^[0-9a-f-]{36}\.json$/;
function startTtsControl({directory,command,status,onError=()=>{}}){
  fs.mkdirSync(directory,{recursive:true});let busy=false;
  async function poll(){
    if(busy)return;busy=true;
    try{
      for(const name of fs.readdirSync(directory).filter(n=>valid.test(n))){
        const file=path.join(directory,name);let result;
        try{
          if(fs.statSync(file).size>1024)throw Error('Invalid TTS control request');
          const request=JSON.parse(fs.readFileSync(file,'utf8'));
          if(Date.now()-request.createdAt>120000||!Number.isFinite(request.createdAt))throw Error('Expired TTS control request');
          if(!['pause','resume','status'].includes(request.action))throw Error('Invalid TTS action');
          await command(request.action);result={ok:true,...status()};
        }catch(e){result={ok:false,error:e.message};}
        writeJsonAtomic(file+'.result',result);fs.unlinkSync(file);
      }
      // Bounded retention; responses contain no chat content or credentials.
      for(const name of fs.readdirSync(directory).filter(n=>/^[0-9a-f-]{36}\.json\.result$/.test(n))){
        const file=path.join(directory,name);if(Date.now()-fs.statSync(file).mtimeMs>300000)fs.unlinkSync(file);
      }
    }catch(e){onError(e);}finally{busy=false;}
  }
  const timer=setInterval(()=>void poll(),250);timer.unref();return ()=>clearInterval(timer);
}
async function sendTtsControl(directory,action,{timeoutMs=90000}={}){
  if(!['pause','resume','status'].includes(action))throw Error('Use pause, resume or status');
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,crypto.randomUUID()+'.json');
  writeJsonAtomic(file,{action,createdAt:Date.now()});
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
    if(fs.existsSync(file+'.result')){
      const result=JSON.parse(fs.readFileSync(file+'.result','utf8'));fs.unlinkSync(file+'.result');
      if(!result.ok)throw Error(result.error);return result;
    }
    await new Promise(r=>setTimeout(r,100));
  }
  // Do not leave an unconsumed command that could execute on a later restart.
  try{fs.unlinkSync(file);}catch{}
  throw Error('TTS control timed out; check bot status before retrying');
}
module.exports={startTtsControl,sendTtsControl};
