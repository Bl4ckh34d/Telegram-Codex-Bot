const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('bound topic text and slash commands bypass bot command/router paths; attachments never spawn CLI',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../bot.js'),'utf8');const start=source.indexOf('async function handleIncomingMessage(msg)'),end=source.indexOf('\nasync function ',start+1);
 const routed=[],sent=[];const noop=()=>({});
 const context=vm.createContext({conversationKey:()=>'-1~2',senderLabel:()=>'',buildReplyContextFromIncomingMessage:noop,isAllowedMessage:()=>true,recordIncomingTelegramMessageMeta:noop,buildReplyThreadContextFromIncomingMessage:noop,buildRecentHistoryContext:noop,logChat:noop,rememberChatAutomationPrefsFromText:noop,
 appChatBridge:{target:()=>({threadId:'t'}),route:async(c,text)=>{routed.push(text);return true;}},sendMessage:async(c,text)=>sent.push(text),handleCommand:()=>{throw new Error('must not route into bot CLI commands');}});
 vm.runInContext(source.slice(start,end),context);
 await context.handleIncomingMessage({text:'Hello'});await context.handleIncomingMessage({text:'/model astra'});await context.handleIncomingMessage({document:{mime_type:'image/png'}});
 assert.deepEqual(routed,['Hello','/model astra']);assert.equal(sent.length,1);assert.match(sent[0],/Anhänge/);
});
