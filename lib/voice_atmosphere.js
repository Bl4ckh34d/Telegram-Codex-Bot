'use strict';
const {createHash,randomUUID}=require('node:crypto');

// Synthetic spaces, shared by every TTS language. No speech samples or GPU needed.
const PROFILES={
  'hologram-ai':{hum:220,upper:660,noise:'pink',cut:8500,gain:0.045,event:1100,sweep:650,pace:6,room:180},
  'starship-comms':{hum:110,upper:165,noise:'brown',cut:2400,gain:0.06,event:880,sweep:280,pace:3.5,room:65},
  'cyber-oracle':{hum:55,upper:83,noise:'brown',cut:700,gain:0.065,event:95,sweep:-40,pace:7,room:270},
  'alien-terminal':{hum:137,upper:223,noise:'pink',cut:3500,gain:0.05,event:430,sweep:1200,pace:4.5,room:130},
  anonymous:{hum:90,upper:180,noise:'brown',cut:1000,gain:0.045,event:260,sweep:-100,pace:8,room:85},
};
function addVoiceAtmosphere(config,preset,filters,{enabled=true,level=1,offset=0,seed=randomUUID()}={}) {
  const p=PROFILES[preset];
  const required=['asplit','sine','anoisesrc','lowpass','highpass','volume','amix','sidechaincompress','aresample'];
  if(!enabled||!p||!required.every(x=>filters.has(x)))return config;
  const strength=Math.max(0,Math.min(1,Number(level)||0));
  if(!strength)return config;
  const bytes=createHash('sha256').update(`${seed}:${preset}`).digest();
  const rand=i=>bytes[i%bytes.length]/255;
  const f=x=>Number(x.toFixed(5));
  const base=config.mode==='complex'?config.graph:`[0:a]${config.graph||'anull'}[amb_voice_base]`;
  const label=config.mode==='complex'?config.mapLabel:'amb_voice_base';
  const gain=p.gain*strength;
  const parts=[base,
    `[${label}]asplit=2[amb_voice][amb_control]`,
    `sine=frequency=${f(p.hum*(0.96+rand(0)*0.08))}:sample_rate=48000,volume='${f(gain)}*(0.8+0.2*sin(2*PI*t/${f(9+rand(1)*11)}+${f(rand(2)*6)}))':eval=frame[amb_hum]`,
    `sine=frequency=${f(p.upper*(0.97+rand(3)*0.06))}:sample_rate=48000,volume=${f(gain*0.32)}[amb_upper]`,
    `anoisesrc=color=${p.noise}:seed=${bytes.readUInt32LE(4)}:amplitude=${f(0.004*strength)}:r=48000,highpass=f=45,lowpass=f=${p.cut},volume='0.8+0.2*sin(2*PI*t/${f(5+rand(8)*7)})':eval=frame[amb_noise]`,
  ];
  const layers=['amb_hum','amb_upper','amb_noise'];
  if(filters.has('aevalsrc')) {
    // Independent, staggered events: smooth sample-level envelopes avoid clicks.
    // Different periods and seeds prevent a repeated beep on every sentence.
    for(let i=0;i<3;i++) {
      const duration=preset==='starship-comms'?0.07+rand(9+i)*0.15:0.35+rand(9+i)*1.1;
      const period=p.pace*(1.1+i*0.71+rand(12+i));
      const phase=rand(15+i)*period+Number(offset||0);
      const u=`mod(t+${f(phase)},${f(period)})`;
      const envelope=`pow(max(0,sin(PI*min(${u}/${f(duration)},1))),2)*lt(${u},${f(duration)})`;
      const frequency=p.event*(0.7+rand(18+i)*0.8);
      const sweep=p.sweep*(rand(21+i)*1.4-0.35);
      const expression=`${f(strength*(preset==='starship-comms'?0.009:0.005))}*${envelope}*sin(2*PI*(${f(frequency)}*${u}+${f(sweep/2)}*${u}*${u}))`;
      parts.push(`aevalsrc=exprs='${expression}':s=48000[amb_event${i}]`);
      layers.push(`amb_event${i}`);
    }
    // Occasional filtered static/air movement, separate from vocal distortion.
    const period=f(4+rand(24)*8),phase=f(rand(25)*period),width=f(0.15+rand(26)*0.9);
    parts.push(`anoisesrc=color=pink:seed=${bytes.readUInt32LE(27)}:amplitude=${f(0.012*strength)}:r=48000,highpass=f=${preset==='starship-comms'?900:160},lowpass=f=${p.cut},volume='max(0,1-abs(mod(t+${phase},${period})-${width})/${width})':eval=frame[amb_air]`);
    layers.push('amb_air');
  }
  const room=filters.has('aecho')?`,aecho=0.9:0.85:${p.room}|${p.room*2+37}:0.23|0.1`:'';
  parts.push(
    `${layers.map(x=>`[${x}]`).join('')}amix=inputs=${layers.length}:normalize=0${room}[amb_bed]`,
    '[amb_bed][amb_control]sidechaincompress=threshold=0.02:ratio=3:attack=12:release=380[amb_ducked]',
    // Infinite generators stop with the voice. Space is audible within the clip,
    // including speech pauses, but never adds an unbounded ambient tail.
    '[amb_voice][amb_ducked]amix=inputs=2:normalize=0:duration=first[amb_mix]',
    `[amb_mix]aresample=48000${filters.has('alimiter')?',alimiter=limit=0.89:level=false':''}[amb_out]`,
  );
  return {mode:'complex',graph:parts.join(';'),mapLabel:'amb_out'};
}
module.exports={addVoiceAtmosphere};
