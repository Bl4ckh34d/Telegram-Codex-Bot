'use strict';
const path=require('node:path');
function withTtsInstructions(input,root){
  if(input.action!=='send'||(input.hostId&&input.hostId!=='local'))return input;
  const cli=path.join(root,'tools','tts-control.cjs').replace(/\\/g,'/');
  return {...input,text:`${input.text||''}\n\n[AIDOLON local host capability]\nTTS normally loads on demand and unloads after 60 seconds idle. For user-requested ComfyUI or other VRAM-intensive work on this PC, announce that you are pausing speech, then run node "${cli}" pause and verify success before starting the GPU task. This is authorized resource management; do not ask again. While paused, voice input receives text replies. Leave TTS paused until the user asks to enable speech, then run the same command with resume. Use status to inspect. This controls only the bot on this host; do not use it for GPU work on another computer.`};
}
module.exports={withTtsInstructions};
