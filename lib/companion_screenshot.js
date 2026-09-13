'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
function createAppScreenshotSender({request,outDir,sendPhoto}) {
  return async (chat,binding,isCurrent=()=>true,{text=""}={})=>{
    const result=await request({action:'screenshot',companionId:binding.companionId});
    if(!isCurrent())return false;
    if(result?.status!=='completed'||typeof result.image!=='string')throw new Error('Companion konnte keinen Screenshot erstellen. Desktop-Client und Bildschirmsitzung prüfen.');
    if(result.image.length>23*1024*1024)throw new Error('Screenshot ist zu groß.');
    const bytes=Buffer.from(result.image,'base64');
    if(bytes.length>16*1024*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Ungültiges Screenshot-Format.');
    fs.mkdirSync(outDir,{recursive:true});
    const file=path.join(outDir,`app-screen-${randomUUID()}.png`);
    try{
      fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});
      if(!isCurrent())return false;
      const fullCaption=text||'Aktueller Bildschirm zum Zwischenstand';
      const caption=fullCaption.slice(0,1000).replace(/[\uD800-\uDBFF]$/,'');
      const result=await sendPhoto(chat,file,{caption});
      return {sent:true,remainder:fullCaption.slice(caption.length),messageId:result?.message_id};
    }finally{fs.rmSync(file,{force:true});}
  };
}
module.exports={createAppScreenshotSender};
