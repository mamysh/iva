export const UPDATE_USERBOT_SERVICE = "iva-telegram-userbot.service";

export function updateServicePlan(userbotActive = false) {
  return {
    stopGroups: [
      ["iva-telegram-poll.service", ...(userbotActive ? [UPDATE_USERBOT_SERVICE] : [])],
      ["iva.service"],
    ],
    restartUserbot: userbotActive,
  };
}
