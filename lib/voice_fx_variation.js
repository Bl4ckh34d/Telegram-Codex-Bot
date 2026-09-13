'use strict';
const {createHash,randomUUID}=require('node:crypto');
function createVoiceFxVariation(seed=randomUUID()) {
  const bytes=createHash('sha256').update(String(seed)).digest();
  const n=i=>bytes[i]/255;
  const round=x=>Math.round(x*1000)/1000;
  return {
    period:round(0.9+n(0)*0.2),offset:round(n(1)*0.4),gain:round(0.85+n(2)*0.3),
    pitch:round(0.98+n(3)*0.04),shadowDelay:Math.round(-15+n(4)*30),
    slots:[{start:round(0.65+n(5)*0.6),length:round(0.065+n(6)*0.025)},
      {start:round(3.8+n(7)*1.2),length:round(0.07+n(8)*0.025)}],
  };
}
module.exports={createVoiceFxVariation};
