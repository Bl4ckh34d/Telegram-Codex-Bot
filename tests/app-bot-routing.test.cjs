const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('bound topic text and slash commands bypass bot command/router paths; attachments never spawn CLI',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../bot.js'),'utf8');const start=source.indexOf('async function handleIncomingMessage(msg)'),end=source.indexOf('\nasync function ',start+1);
 const routed=[],sent=[],files=[],lifecycle=[],renames=[];const noop=()=>({});
 const context=vm.createContext({conversationKey:()=>'-1~2',senderLabel:()=>'',buildReplyContextFromIncomingMessage:noop,isAllowedMessage:()=>true,recordIncomingTelegramMessageMeta:noop,buildReplyThreadContextFromIncomingMessage:noop,buildRecentHistoryContext:noop,logChat:noop,rememberChatAutomationPrefsFromText:noop,
 appChatBridge:{target:()=>({threadId:'t'}),topicRenamed:async(c,name)=>renames.push(name),topicLifecycle:async(c,kind)=>lifecycle.push(kind),route:async(c,text)=>{routed.push(text);return true;}},handleAppAttachment:async msg=>files.push(msg),sendMessage:async(c,text)=>sent.push(text),handleCommand:()=>{throw new Error('must not route into bot CLI commands');}});
 vm.runInContext(source.slice(start,end),context);
 await context.handleIncomingMessage({text:'Hello'});await context.handleIncomingMessage({text:'/model astra'});await context.handleIncomingMessage({document:{mime_type:'image/png'}});
 assert.deepEqual(routed,['Hello','/model astra']);assert.equal(sent.length,0);assert.equal(files.length,1);
 let speechCommand;context.handleCommand=async(c,text)=>{speechCommand=text;return true;};
 await context.handleIncomingMessage({text:'/speech pause'});assert.equal(speechCommand,'/speech pause');assert.equal(routed.length,2);
 await context.handleIncomingMessage({text:'/exit'});assert.equal(speechCommand,'/exit');assert.equal(routed.length,2);
 await context.handleIncomingMessage({forum_topic_closed:{},from:{is_bot:false}});await context.handleIncomingMessage({forum_topic_closed:{},from:{is_bot:true}});assert.deepEqual(lifecycle,['closed']);
 await context.handleIncomingMessage({forum_topic_edited:{name:'PC · New'},from:{is_bot:false}});await context.handleIncomingMessage({forum_topic_edited:{name:'echo'},from:{is_bot:true}});await context.handleIncomingMessage({forum_topic_edited:{icon_custom_emoji_id:'1'},from:{is_bot:false}});assert.deepEqual(renames,['PC · New']);
});
