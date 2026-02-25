/* @format */
// src/yolkbotIndex.js
//
// Main lobby factory + in-memory registry.
// IMPORTANT: We bind the passed yolkbot client into src/yolkbotClient.js
// so gamemodes can call getBotInstance() safely.

import { setBotInstance } from "./yolkbotClient.js";

const activeByGuild = new Map();
const activeByGameId = new Map();

export function getActiveLobbyForGuild(guildId) {
  return activeByGuild.get(guildId);
}

export function getActiveLobbyByGameId(gameId) {
  return activeByGameId.get(gameId);
}

export function clearActiveLobbyForGuild(guildId) {
  const existing = activeByGuild.get(guildId);
  if (existing) activeByGameId.delete(existing.gameId);
  activeByGuild.delete(guildId);
}

export function clearActiveLobbyByGameId(gameId) {
  const existing = activeByGameId.get(gameId);
  if (existing) activeByGuild.delete(existing.guildId);
  activeByGameId.delete(gameId);
}

function setActiveLobby(lobby) {
  const prev = activeByGuild.get(lobby.guildId);
  if (prev) activeByGameId.delete(prev.gameId);

  activeByGuild.set(lobby.guildId, lobby);
  activeByGameId.set(lobby.gameId, lobby);
}

function requireFn(fn, label) {
  if (typeof fn !== "function") {
    throw new Error(
      `[yolkbot] Missing client method: ${label}. Add it to your wrapper or map it.`
    );
  }
  return fn;
}

function pickGameId(result) {
  const id =
    result?.gameId ??
    result?.id ??
    result?.game?.id ??
    result?.data?.gameId ??
    result?.data?.id;

  if (!id) {
    throw new Error(
      `[yolkbot] Could not extract gameId from create response. Keys: ${
        result ? Object.keys(result).join(", ") : "(none)"
      }`
    );
  }
  return String(id);
}

/**
 * params = { mode, guildId, channelId, createdBy, region, map, options }
 */
export async function createLobby(client, params) {
  if (!client) {
    throw new Error("[yolkbot] createLobby(client, params) missing client instance.");
  }

  // ✅ THIS is the hook your gamemodes need
  // Now killStreaks.js (and others) can call getBotInstance() and get THIS same client.
  setBotInstance(client);

  const existing = getActiveLobbyForGuild(params.guildId);
  if (existing) {
    throw new Error(
      `[yolkbot] Lobby already active for guild "${params.guildId}" (${existing.mode}). Clear it first.`
    );
  }

  const mode = params.mode;
  const region = params.region;
  const map = params.map;

  let result;

  if (mode === "kotc") {
    const fn = requireFn(client.createKotcGame, "createKotcGame");
    result = await fn({ region, map, ...(params.options ?? {}) });
  } else if (mode === "teams") {
    const fn = requireFn(client.createTdmGame, "createTdmGame");
    result = await fn({ region, map, ...(params.options ?? {}) });
  } else if (mode === "ffa") {
    const fn = requireFn(client.createFfaGame, "createFfaGame");
    result = await fn({ region, map, ...(params.options ?? {}) });
  } else {
    const fn = requireFn(client.createGame, "createGame");
    result = await fn({ region, map, mode, ...(params.options ?? {}) });
  }

  const gameId = pickGameId(result);

  const lobby = {
    guildId: params.guildId,
    channelId: params.channelId,
    createdBy: params.createdBy,
    mode,
    region,
    map,
    gameId,
    createdAt: Date.now(),
    meta: { createResult: result ?? null, options: params.options ?? {} },
  };

  setActiveLobby(lobby);
  return lobby;
}
