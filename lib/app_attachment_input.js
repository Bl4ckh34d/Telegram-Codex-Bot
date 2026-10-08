'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {MAX_BYTES,safeName}=require('../companion/app-attachments');
function createAppAttachmentHandler({getBridge,routeKey,getFile,download,sendText,stagingRoot}){
  const pending=new Map();
  return async function handleAppAttachment(msg){
    const chat=routeKey(msg),bridge=getBridge(),binding=bridge?.target(chat);
    if(!binding)return;
    const expected={...binding};
    const key=JSON.stringify([chat,msg.message_id,expected.bindingId]);
    if(pending.has(key))return pending.get(key);
    const work=(async()=>{
      let folder;
      try{
        const photos=Array.isArray(msg.photo)?msg.photo:[];
        const photo=photos.reduce((a,b)=>!a||Number(b.width)*Number(b.height)>Number(a.width)*Number(a.height)?b:a,null);
        const file=photo||msg.document;
        if(!file?.file_id)throw new Error('Telegram-Datei-ID fehlt.');
        if(Number(file.file_size)>MAX_BYTES)throw new Error('Datei zu groß. Maximal 20 MiB pro Datei.');
        const meta=await getFile(file.file_id);
        if(!meta?.file_path)throw new Error('Telegram-Datei nicht verfügbar.');
        if(Number(meta.file_size)>MAX_BYTES)throw new Error('Datei zu groß. Maximal 20 MiB pro Datei.');
        fs.mkdirSync(stagingRoot,{recursive:true});folder=fs.mkdtempSync(path.join(stagingRoot,'download-'));
        const local=path.join(folder,'payload');await download(meta.file_path,local,{maxBytes:MAX_BYTES});
        const stat=fs.statSync(local);if(!stat.isFile()||!stat.size||stat.size>MAX_BYTES)throw new Error('Leere oder zu große Datei.');
        const bytes=fs.readFileSync(local);
        const attachment={name:safeName(photo?`photo-${msg.message_id}.jpg`:file.file_name||'document'),dataBase64:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
        await bridge.route(chat,String(msg.caption||''),expected,{attachments:[attachment],deliveryId:crypto.createHash('sha256').update(JSON.stringify([chat,msg.message_id,file.file_id])).digest('hex')});
      }catch(e){await sendText(chat,`Datei konnte nicht an die App übergeben werden: ${e.message}`);}
      finally{if(folder){const payload=path.join(folder,'payload');try{fs.unlinkSync(payload);}catch{}try{fs.rmdirSync(folder);}catch{}}}
    })();
    pending.set(key,work);try{return await work;}finally{pending.delete(key);}
  };
}
module.exports={createAppAttachmentHandler};
