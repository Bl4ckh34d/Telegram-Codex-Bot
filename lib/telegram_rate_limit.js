'use strict';
const {setTimeout:delay}=require('node:timers/promises');
async function retryTelegramRateLimit(operation,{signal,maxRetries=2,wait=ms=>delay(ms,undefined,{signal})}={}){
  for(let attempt=0;;attempt++){
    signal?.throwIfAborted();
    try{return await operation();}
    catch(error){
      if(!error.deliveryRejected||!(error.retryAfter>0)||attempt>=maxRetries)throw error;
      await wait(error.retryAfter*1000);
    }
  }
}
module.exports={retryTelegramRateLimit};
