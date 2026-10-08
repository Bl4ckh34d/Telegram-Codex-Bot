#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {sendTtsControl}=require('../lib/tts_control');
sendTtsControl(path.resolve(__dirname,'../runtime/tts-control'),process.argv[2]||'status')
  .then(result=>console.log(JSON.stringify(result,null,2)))
  .catch(error=>{console.error(error.message);process.exitCode=1;});
