"use strict";
function createWorkspaceCommandHandlers(deps = {}) {
  const {sendHelp,clearAllSessionsForChat,setActiveWorkerForChat,ORCH_GENERAL_WORKER_ID,
    clearLastImageForChat,sendCodexCommandMenu,sendStatus,sendQueue,sendMessage}=deps;
  const retired=async chat=>{await sendMessage(chat,"Worker routing is retired. General chat uses one CLI assistant. Use /app new in the topic group to choose a device and project.");return true;};
  return {
    "/help":async chat=>{await sendHelp(chat);return true;},
    "/start":async chat=>{clearAllSessionsForChat(chat);setActiveWorkerForChat(chat,ORCH_GENERAL_WORKER_ID);clearLastImageForChat(chat);await sendHelp(chat);return true;},
    "/codex":async chat=>{await sendCodexCommandMenu(chat);return true;},
    "/commands":async chat=>{await sendCodexCommandMenu(chat);return true;},
    "/status":async chat=>{await sendStatus(chat);return true;},
    "/queue":async chat=>{await sendQueue(chat);return true;},
    "/workers":retired,"/capabilities":retired,"/use":retired,"/spawn":retired,"/retire":retired,
  };
}
module.exports={createWorkspaceCommandHandlers};
