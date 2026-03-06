"use strict";

function createMonitorCommandHandlers(deps = {}) {
  const {
    handleWeatherCommand,
    handleNewsCommand,
    handleNewsReportCommand,
    sendWorldMonitorStatus,
  } = deps;

  return {
    "/weather": async (chatId, parsed) => {
      await handleWeatherCommand(chatId, parsed.arg || "");
      return true;
    },
    "/news": async (chatId, parsed) => {
      await handleNewsCommand(chatId, parsed.arg || "");
      return true;
    },
    "/newsreport": async (chatId, parsed) => {
      await handleNewsReportCommand(chatId, parsed.arg || "");
      return true;
    },
    "/newsstatus": async (chatId) => {
      await sendWorldMonitorStatus(chatId);
      return true;
    },
  };
}

module.exports = {
  createMonitorCommandHandlers,
};
