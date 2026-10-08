const test=require('node:test'),assert=require('node:assert/strict');
test('retries only explicit Telegram rate-limit rejections using server delay',async()=>{
 const {retryTelegramRateLimit}=require('../lib/telegram_rate_limit');let calls=0;const waits=[];
 const result=await retryTelegramRateLimit(async()=>{if(!calls++){const e=new Error('429');e.deliveryRejected=true;e.retryAfter=12;throw e;}return 'sent';},{wait:async ms=>waits.push(ms)});
 assert.equal(result,'sent');assert.equal(calls,2);assert.deepEqual(waits,[12000]);
 calls=0;await assert.rejects(retryTelegramRateLimit(async()=>{calls++;throw new Error('uncertain timeout');},{wait:async()=>{}}),/timeout/);assert.equal(calls,1);
});
test('cancellation during rate-limit wait prevents another delivery attempt',async()=>{
 const {retryTelegramRateLimit}=require('../lib/telegram_rate_limit');const controller=new AbortController();let calls=0;
 await assert.rejects(retryTelegramRateLimit(async()=>{calls++;const e=new Error('429');e.deliveryRejected=true;e.retryAfter=3;throw e;},{signal:controller.signal,wait:async()=>controller.abort()}),/abort/i);assert.equal(calls,1);
});
