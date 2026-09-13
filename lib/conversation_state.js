"use strict";
function createConversationState() {
  const sessions = new Map();
  const audio = new Map();
  const sessionKey = (chat, worker) => `${chat}:${worker}`;
  return {
    sessionVersion: (chat, worker) => sessions.get(sessionKey(chat, worker)) || 0,
    resetSession(chat, worker) {
      const key = sessionKey(chat, worker);
      sessions.set(key, (sessions.get(key) || 0) + 1);
    },
    audioVersion: chat => audio.get(String(chat)) || 0,
    interruptAudio(chat) {
      const key = String(chat); audio.set(key, (audio.get(key) || 0) + 1);
      return audio.get(key);
    },
  };
}
module.exports = { createConversationState };
