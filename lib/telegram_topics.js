'use strict';
// Route keys are filesystem-safe and keep all existing per-chat state topic-local.
function splitRoute(value) {
  const raw=String(value||'');
  const match=/^(-?\d+)~([1-9]\d*)$/.exec(raw);
  return match?{chatId:match[1],threadId:Number(match[2])}:{chatId:raw,threadId:null};
}
function conversationKey(message) {
  const chat=String(message?.chat?.id||'');
  const thread=Number(message?.message_thread_id);
  return message?.is_topic_message&&Number.isSafeInteger(thread)&&thread>1?`${chat}~${thread}`:chat;
}
function routeBody(method, body) {
  if(!body||body.chat_id==null)return body;
  const {chatId,threadId}=splitRoute(body.chat_id);
  if(!threadId)return body;
  const result={...body,chat_id:chatId};
  if(/^send/.test(method)||method==='copyMessage'||method==='forwardMessage')result.message_thread_id=threadId;
  return result;
}
function routeMultipart(method, form) {
  const body=routeBody(method,{chat_id:form.get('chat_id')});
  if(body.chat_id!=null)form.set('chat_id',body.chat_id);
  if(body.message_thread_id)form.set('message_thread_id',String(body.message_thread_id));
}
module.exports={splitRoute,conversationKey,routeBody,routeMultipart};
