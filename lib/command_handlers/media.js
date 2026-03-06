"use strict";

function createMediaCommandHandlers(deps = {}) {
  const {
    sendMessage,
    setChatPrefs,
    sendModelPicker,
    VISION_ENABLED,
    getLastImageForChat,
    getActiveSessionForChat,
    enqueuePrompt,
    captureScreenshotsWithFallback,
    IMAGE_DIR,
    setLastImageForChat,
    pathBasename,
    platform,
    clearLastImageForChat,
    handleVoicePresetCommand,
    handleTtsAbTestCommand,
    TTS_ENABLED,
    parseTtsCommandInput,
    splitSpeakableTextIntoVoiceChunks,
    enqueueTtsBatch,
    enqueueTts,
  } = deps;

  return {
    "/model": async (chatId, parsed) => {
      const arg = String(parsed.arg || "").trim().toLowerCase();
      if (["clear", "reset", "defaults", "default", "off", "none"].includes(arg)) {
        setChatPrefs(chatId, { model: "", reasoning: "" });
        await sendMessage(chatId, "Model preferences cleared for this chat (back to defaults).");
        return true;
      }
      await sendModelPicker(chatId);
      return true;
    },
    "/ask": async (chatId, parsed) => {
      if (!VISION_ENABLED) {
        await sendMessage(chatId, "Vision is disabled on this bot (VISION_ENABLED=0).");
        return true;
      }
      const q = String(parsed.arg || "").trim();
      if (!q) {
        await sendMessage(chatId, "Usage: /ask <question> (analyzes your last sent image)");
        return true;
      }
      const img = getLastImageForChat(chatId);
      if (!img) {
        await sendMessage(chatId, "No image found for this chat. Send an image first (optionally with a caption).");
        return true;
      }
      const activeSession = getActiveSessionForChat(chatId);
      await enqueuePrompt(chatId, q, "ask-image", {
        resumeSessionId: activeSession || "",
        imagePaths: [img.path],
      });
      return true;
    },
    "/see": async (chatId, parsed) => {
      if (!VISION_ENABLED) {
        await sendMessage(chatId, "Vision is disabled on this bot (VISION_ENABLED=0).");
        return true;
      }
      const q = String(parsed.arg || "").trim();
      if (!q) {
        await sendMessage(chatId, "Usage: /see <question> (takes a screenshot, then analyzes it)");
        return true;
      }
      if (platform !== "win32") {
        await sendMessage(chatId, "Screenshot vision is only configured for Windows in this bot.");
        return true;
      }

      const prefix = `see-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      void (async () => {
        try {
          const paths = await captureScreenshotsWithFallback(IMAGE_DIR, prefix);
          // Keep the primary screenshot as the "last image" context.
          const primaryPath = String(paths[0] || "").trim();
          if (primaryPath) {
            setLastImageForChat(chatId, { path: primaryPath, mime: "image/png", name: pathBasename(primaryPath) });
          }
          const activeSession = getActiveSessionForChat(chatId);
          await enqueuePrompt(chatId, q, "see-screenshot", {
            resumeSessionId: activeSession || "",
            imagePaths: paths,
          });
        } catch (err) {
          await sendMessage(chatId, `Screenshot vision failed: ${String(err?.message || err)}`);
        }
      })();
      return true;
    },
    "/imgclear": async (chatId) => {
      clearLastImageForChat(chatId);
      await sendMessage(chatId, "Cleared last image context.");
      return true;
    },
    "/voice": async (chatId, parsed) => {
      return await handleVoicePresetCommand(chatId, parsed.arg);
    },
    "/abtest": async (chatId, parsed) => {
      return await handleTtsAbTestCommand(chatId, parsed.arg || "");
    },
    "/tts": async (chatId, parsed) => {
      if (!TTS_ENABLED) {
        await sendMessage(chatId, "TTS is disabled on this bot (TTS_ENABLED=0).");
        return true;
      }
      const ttsInput = parseTtsCommandInput(parsed.arg || "");
      if (!ttsInput.ok) {
        await sendMessage(chatId, ttsInput.error || "Usage: /tts <text>");
        return true;
      }
      const q = String(ttsInput.text || "").trim();
      const presetOverride = String(ttsInput.preset || "").trim();
      // Never truncate user input for TTS; split into as many voice notes as needed.
      const { chunks, overflowText } = splitSpeakableTextIntoVoiceChunks(q);
      const all = chunks.length > 0 ? chunks : [q];
      if (overflowText) all.push(overflowText);
      if (all.length > 1) {
        await enqueueTtsBatch(chatId, all, "tts-command", { ttsPreset: presetOverride });
      } else {
        await enqueueTts(chatId, all[0], "tts-command", { ttsPreset: presetOverride });
      }
      return true;
    },
  };
}

module.exports = {
  createMediaCommandHandlers,
};
