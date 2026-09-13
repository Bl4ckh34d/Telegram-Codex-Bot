'use strict';
const ONES=['null','eins','zwei','drei','vier','fünf','sechs','sieben','acht','neun','zehn','elf','zwölf','dreizehn','vierzehn','fünfzehn','sechzehn','siebzehn','achtzehn','neunzehn'];
const TENS=['','','zwanzig','dreißig','vierzig','fünfzig','sechzig','siebzig','achtzig','neunzig'];
function germanInteger(n) {
  if(n<20)return ONES[n];
  if(n<100)return (n%10?(n%10===1?'ein':ONES[n%10])+'und':'')+TENS[Math.floor(n/10)];
  if(n<1000)return (Math.floor(n/100)===1?'ein':ONES[Math.floor(n/100)])+'hundert'+(n%100?germanInteger(n%100):'');
  if(n<1000000)return (Math.floor(n/1000)===1?'ein':germanInteger(Math.floor(n/1000)))+'tausend'+(n%1000?germanInteger(n%1000):'');
  for(const [scale,one,many] of [[1e12,'Billion','Billionen'],[1e9,'Milliarde','Milliarden'],[1e6,'Million','Millionen']]){
    if(n>=scale){const head=Math.floor(n/scale),rest=n%scale;return (head===1?'eine '+one:germanInteger(head)+' '+many)+(rest?' '+germanInteger(rest):'');}
  }
}
function germanMoneyNumber(localized, currencyName) {
  const match=String(localized).match(/^(minus |plus )?(\d+)(?:,(\d+))?$/);
  if(!match)return localized;
  const [,sign='',whole,fraction]=match;
  const n=Number(whole);
  const integer=Number.isSafeInteger(n)?germanInteger(n):[...whole].map(d=>ONES[Number(d)]).join(' ');
  if(fraction!==undefined)return `${sign}${integer} Komma ${[...fraction].map(d=>ONES[Number(d)]).join(' ')}`;
  if(n===1)return sign+(/(?:Rupie|Krone|Lira|Hrywnja)$/.test(currencyName)?'eine':'ein');
  return sign+integer;
}
module.exports={germanMoneyNumber,germanInteger};
