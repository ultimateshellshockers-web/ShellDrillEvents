/** @format */
// src/yolkbotClient.js
//
// Singleton yolkbot instance + “ready” helper.
// Fixes: "Bot instance is not set" by actually creating/logging in a bot.

import Bot from "yolkbot/bot";

let BOT = null;
let READY = null;

function startInitIfNeeded() {
  if (READY) return READY;

  READY = (async () => {
    const bot = new Bot();

    // Default: anonymous auth (works for testing and private games)
    // If you want email/pass later, add envs and swap auth method.
    try {
      await bot.loginAnonymously();
    } catch (e) {
      // If auth fails, clear READY so retries are possible
      READY = null;
      throw new Error(`[yolkbotClient] loginAnonymously() failed: ${e?.message || e}`);
    }

    BOT = bot;
    return BOT;
  })();

  return READY;
}

export function setBotInstance(bot) {
  BOT = bot;
  // If you manually set it, consider it "ready".
  if (!READY) READY = Promise.resolve(BOT);
}

export async function ensureBotInstance() {
  if (BOT) return BOT;
  return startInitIfNeeded();
}

export function getBotInstance() {
  if (!BOT) {
    throw new Error(
      "[yolkbotClient] Bot instance is not set. Call ensureBotInstance() first, or setBotInstance(bot) at startup."
    );
  }
  return BOT;
}

// Aliases (because your imports keep shape-shifting)
export const getBot = getBotInstance;
export const getClient = getBotInstance;

// Default export support (some loaders look for default.getBotInstance())
export default {
  getBotInstance,
  getBot,
  getClient,
  ensureBotInstance,
  setBotInstance,
};
