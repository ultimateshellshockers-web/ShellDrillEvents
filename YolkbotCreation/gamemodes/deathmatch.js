/** @format */
// gamemodes/deathmatch.js

import { ensureBotInstance } from "../src/yolkbotClient.js";
import { GameMode } from "yolkbot/constants";

const DEFAULT_REGION = "uscentral";
const DEFAULT_MAP = "cluckgrounds";
const BOT_NAME = process.env.YOLKBOT_NAME?.trim() || "Shell Drill Events";
const HELLO_MSG = process.env.DEATHMATCH_HELLO?.trim() || "hi";

const ALLOWED_REGIONS = new Set(["uscentral", "germany"]);
const ALLOWED_MAPS = new Set(["castle", "blue", "growler", "cluckgrounds"]);

const HELLO_SENT = new Set();

const ARMED = Symbol("deathmatchArmed");
const RECENT = Symbol("deathmatchRecentKills");
const KILLS = Symbol("deathmatchKillsPerPlayer");

const GAME_STATE = new Map(); // gameId -> { createdAt, startedAt, endsAt, updatedAt, configuredTimeLimitSeconds, players: Map(...) }
const WIN_CFG = new Map(); // gameId -> { target, timeLimitSeconds, onWin, fired }
const GAME_OVER = new Set();
const STARTING_GAMES = new Set(); // gameId(s) currently in countdown

const s = (x) => String(x ?? "").trim();
const n = (x) => s(x).toLowerCase();

function normalizeChoice(value, allowedSet, fallback) {
  const v = n(value);
  return allowedSet.has(v) ? v : fallback;
}

function canBotChat(bot) {
  return Boolean(bot?.game?.isPrivate || bot?.account?.emailVerified || bot?.account?.isAged);
}

function safeOff(bot, evt, fn) {
  try {
    bot?.off?.(evt, fn);
  } catch {}
  try {
    bot?.removeListener?.(evt, fn);
  } catch {}
}

function getPlayersArray(bot) {
  const p = bot?.players ?? bot?.game?.players;
  if (!p) return [];
  if (p instanceof Map) return [...p.values()];
  if (Array.isArray(p)) return p;
  if (typeof p === "object") return Object.values(p);
  return [];
}

function playerName(p) {
  return s(p?.name ?? p?.playerName ?? p?.username ?? p?.nick ?? "");
}

function myBotName(bot) {
  return s(bot?.me?.name ?? bot?.player?.name ?? BOT_NAME);
}

function isBotName(bot, name) {
  const nm = s(name);
  if (!nm) return true;
  if (n(nm) === n(BOT_NAME)) return true;
  if (n(nm) === n(myBotName(bot))) return true;
  return false;
}

function isBotPlayer(bot, player) {
  const name = playerName(player);
  if (!name) return true;

  if (n(name) === n(BOT_NAME)) return true;

  const my = bot?.me ?? bot?.player ?? {};
  const myId = s(my?.uniqueId ?? my?.id ?? "");
  const pId = s(player?.uniqueId ?? player?.id ?? "");
  if (myId && pId && myId === pId) return true;

  return false;
}

function pickName(x) {
  if (!x) return "";
  if (typeof x === "string") return s(x);
  if (typeof x === "object") return playerName(x) || s(x?.username ?? x?.name ?? x?.playerName ?? "");
  return s(x);
}

function extractKillInfo(args) {
  const a0 = args?.[0];
  const a1 = args?.[1];

  // Case A: (killer, victim)
  if ((typeof a0 === "string" || typeof a0 === "object") && a1) {
    const killerName = pickName(a0);
    const victimName = pickName(a1);
    return { killerName, victimName };
  }

  // Case B: single payload object
  const payload = a0 && typeof a0 === "object" && !Array.isArray(a0) ? a0 : null;
  const nested = payload?.data ?? payload?.payload ?? payload?.event ?? payload?.kill ?? null;

  const killer =
    payload?.killer ??
    payload?.attacker ??
    payload?.from ??
    payload?.by ??
    payload?.player ??
    payload?.k ??
    nested?.killer ??
    nested?.attacker ??
    nested?.from ??
    nested?.by ??
    nested?.player ??
    nested?.k;

  const victim =
    payload?.victim ??
    payload?.target ??
    payload?.to ??
    payload?.dead ??
    payload?.v ??
    nested?.victim ??
    nested?.target ??
    nested?.to ??
    nested?.dead ??
    nested?.v;

  const killerName = pickName(killer) || pickName(payload?.killerName ?? payload?.attackerName ?? payload?.fromName);
  const victimName = pickName(victim) || pickName(payload?.victimName ?? payload?.targetName ?? payload?.toName);

  return { killerName, victimName };
}

function pruneRecent(map, now, maxAgeMs = 5000) {
  for (const [k, t] of map.entries()) {
    if (now - t > maxAgeMs) map.delete(k);
  }
}

function ensureGameState(gameId, { timeLimitSeconds = null } = {}) {
  const gid = s(gameId);
  if (!gid) return null;

  if (!GAME_STATE.has(gid)) {
    const now = Date.now();

    GAME_STATE.set(gid, {
      gameId: gid,
      createdAt: now,
      startedAt: null,
      endsAt: null,
      updatedAt: now,
      configuredTimeLimitSeconds:
        Number.isFinite(Number(timeLimitSeconds)) && Number(timeLimitSeconds) > 0 ? Number(timeLimitSeconds) : null,
      players: new Map(), // key -> { name, kills, deaths, present, firstKillAt, lastKillAt, lastSeenAt }
    });
  } else if (Number.isFinite(Number(timeLimitSeconds)) && Number(timeLimitSeconds) > 0) {
    const st = GAME_STATE.get(gid);
    st.configuredTimeLimitSeconds = Number(timeLimitSeconds);
  }

  return GAME_STATE.get(gid);
}

function getOrCreatePlayer(state, key, displayName) {
  const k = n(key);
  if (!state.players.has(k)) {
    state.players.set(k, {
      name: s(displayName) || key,
      kills: 0,
      deaths: 0,
      present: true,
      firstKillAt: null,
      lastKillAt: null,
      lastSeenAt: Date.now(),
    });
  } else {
    const rec = state.players.get(k);
    if (displayName && rec?.name !== displayName) rec.name = s(displayName);
    if (!Number.isFinite(Number(rec?.kills))) rec.kills = 0;
    if (!Number.isFinite(Number(rec?.deaths))) rec.deaths = 0;
    rec.present = true;
    rec.lastSeenAt = Date.now();
  }
  return state.players.get(k);
}

function markNotPresentExcept(state, presentKeys) {
  for (const [k, rec] of state.players.entries()) {
    if (!presentKeys.has(k)) rec.present = false;
  }
}

function syncPlayersFromBot(bot, gameId) {
  if (!bot) return;
  if (gameId && s(bot?.game?.id) && s(bot?.game?.id) !== s(gameId)) return;

  const state = ensureGameState(gameId);
  if (!state) return;

  const now = Date.now();
  const presentKeys = new Set();

  const humans = getPlayersArray(bot).filter((p) => !isBotPlayer(bot, p));
  for (const p of humans) {
    const name = playerName(p);
    if (!name) continue;
    const key = n(name);
    presentKeys.add(key);
    getOrCreatePlayer(state, name, name);
  }

  markNotPresentExcept(state, presentKeys);
  state.updatedAt = now;
}

function unarmDeathmatch(bot) {
  const armed = bot?.[ARMED];
  if (!armed) return;

  if (armed.events && armed.handler) {
    for (const evt of armed.events) safeOff(bot, evt, armed.handler);
  }

  if (Array.isArray(armed.extra)) {
    for (const { evt, fn } of armed.extra) safeOff(bot, evt, fn);
  }

  if (Array.isArray(armed.timers)) {
    for (const t of armed.timers) {
      try {
        clearInterval(t);
      } catch {}
      try {
        clearTimeout(t);
      } catch {}
    }
  }

  delete bot[ARMED];
}

function pickWinner(finalPlayers) {
  const rows = Array.isArray(finalPlayers) ? finalPlayers : [];

  const sorted = rows
    .map((p) => ({
      name: s(p?.name),
      kills: Number(p?.kills || 0),
      firstKillAt: Number(p?.firstKillAt || 0),
      lastKillAt: Number(p?.lastKillAt || 0),
    }))
    .filter((p) => p.name)
    .sort((a, b) => {
      if ((b.kills || 0) !== (a.kills || 0)) return (b.kills || 0) - (a.kills || 0);

      // tie-break: who reached their score first
      if ((a.lastKillAt || 0) !== (b.lastKillAt || 0)) return (a.lastKillAt || 0) - (b.lastKillAt || 0);

      return a.name.localeCompare(b.name);
    });

  return sorted[0] || null;
}

function chatSafe(bot, msg) {
  try {
    bot.emit("chat", msg);
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMinutesLabelFromSeconds(seconds) {
  const secs = Number(seconds || 0);
  if (!Number.isFinite(secs) || secs <= 0) return "0 minutes";

  const wholeMins = Math.ceil(secs / 60);
  return `${wholeMins} ${wholeMins === 1 ? "minute" : "minutes"}`;
}

function formatMinutesShortFromSeconds(seconds) {
  const secs = Number(seconds || 0);
  if (!Number.isFinite(secs) || secs <= 0) return "0m";
  return `${Math.ceil(secs / 60)}m`;
}

// Configure from Discord side (optional)
export function configureDeathmatchWin({ gameId, target, timeLimitSeconds, onWin } = {}) {
  const gid = s(gameId);
  const t = Number.parseInt(target, 10);
  const secs = Number.parseInt(timeLimitSeconds, 10);

  if (!gid) return false;

  const safeTarget = Number.isFinite(t) && t > 0 ? t : null;
  const safeSecs = Number.isFinite(secs) && secs > 0 ? secs : null;

  WIN_CFG.set(gid, {
    target: safeTarget,
    timeLimitSeconds: safeSecs,
    onWin: typeof onWin === "function" ? onWin : null,
    fired: false,
  });

  const st = GAME_STATE.get(gid);
  if (st && safeSecs) st.configuredTimeLimitSeconds = safeSecs;

  GAME_OVER.delete(gid);
  return true;
}

export function getDeathmatchFinalSnapshot(gameId) {
  const state = GAME_STATE.get(s(gameId));
  if (!state) return { players: [] };

  const rows = [...state.players.values()]
    .map((p) => ({
      name: s(p.name),
      kills: Number(p.kills || 0),
      deaths: Number(p.deaths || 0),
      present: Boolean(p.present),
      firstKillAt: p.firstKillAt || null,
      lastKillAt: p.lastKillAt || null,
    }))
    .filter((p) => p.name)
    .sort((a, b) => (b.kills || 0) - (a.kills || 0) || a.name.localeCompare(b.name));

  return { players: rows };
}

export function getDeathmatchSnapshot(gameId, { limit = 10 } = {}) {
  const state = GAME_STATE.get(s(gameId));
  if (!state) return { startedAt: null, endsAt: null, updatedAt: null, players: [], leaderboard: [] };

  const present = [...state.players.values()].filter((p) => p?.present);

  const players = present
    .map((p) => s(p.name))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const leaderboard = present
    .slice()
    .sort(
      (a, b) => (b.kills || 0) - (a.kills || 0) || (a.deaths || 0) - (b.deaths || 0) || a.name.localeCompare(b.name)
    )
    .slice(0, Math.max(0, limit | 0))
    .map((p) => ({
      name: s(p.name),
      kills: Number(p.kills || 0),
      deaths: Number(p.deaths || 0),
    }));

  return { startedAt: state.startedAt, endsAt: state.endsAt, updatedAt: state.updatedAt, players, leaderboard };
}

function armDeathmatchTracker(bot, gameId, { targetNumber, timeLimitSeconds } = {}) {
  unarmDeathmatch(bot);

  // Fresh match state for this round
  bot[RECENT] = new Map();
  bot[KILLS] = new Map();

  const cfgFromMap = WIN_CFG.get(s(gameId));
  const target = Number.isFinite(Number(cfgFromMap?.target)) ? Number(cfgFromMap.target) : Number(targetNumber || 0);
  const secs =
    Number.isFinite(Number(cfgFromMap?.timeLimitSeconds)) && Number(cfgFromMap.timeLimitSeconds) > 0
      ? Number(cfgFromMap.timeLimitSeconds)
      : Number(timeLimitSeconds || 0);

  const state = ensureGameState(gameId, { timeLimitSeconds: secs > 0 ? secs : null });

  // Start the clock NOW (not on lobby creation)
  if (state) {
    const now = Date.now();
    state.startedAt = now;
    state.endsAt = Number.isFinite(secs) && secs > 0 ? now + secs * 1000 : null;
    state.updatedAt = now;

    // Reset player match stats
    for (const rec of state.players.values()) {
      rec.kills = 0;
      rec.deaths = 0;
      rec.firstKillAt = null;
      rec.lastKillAt = null;
      rec.lastSeenAt = now;
    }
  }

  if (cfgFromMap) cfgFromMap.fired = false;
  GAME_OVER.delete(s(gameId));

  const events = Array.from(
    new Set(["kill", "playerKill", "playerKilled", "killFeed", "death", "playerDeath", "gameKill", "killEvent"])
  );

  const endGame = (reason) => {
    const gid = s(gameId);
    if (!gid) return;
    if (GAME_OVER.has(gid)) return;

    GAME_OVER.add(gid);

    const final = getDeathmatchFinalSnapshot(gid);
    const winner = pickWinner(final.players);

    const winnerName = winner?.name || "Unknown";
    const winnerKills = Number(winner?.kills || 0);

    const msg =
      reason === "target"
        ? `/p DEATHMATCH OVER! ${winnerName} wins by reaching ${target} kills! (kills: ${winnerKills})`
        : `/p DEATHMATCH OVER! ${winnerName} wins with ${winnerKills} kills!`;

    chatSafe(bot, msg);

    const cfg = WIN_CFG.get(gid);
    if (cfg && !cfg.fired) cfg.fired = true;

    const payload = {
      gameId: gid,
      reason,
      winnerName,
      target: Number.isFinite(Number(target)) && target > 0 ? target : null,
      timeLimitSeconds: Number.isFinite(Number(secs)) && secs > 0 ? secs : null,
      final,
    };

    if (typeof cfg?.onWin === "function") {
      setTimeout(() => {
        Promise.resolve(cfg.onWin(payload)).catch(() => null);
      }, 0);
    }

    setTimeout(() => unarmDeathmatch(bot), 250);
  };

  const handler = (...args) => {
    if (gameId && s(bot?.game?.id) && s(bot?.game?.id) !== s(gameId)) return;
    if (!canBotChat(bot)) return;
    if (GAME_OVER.has(s(gameId))) return;

    const { killerName, victimName } = extractKillInfo(args);
    const killer = s(killerName);
    const victim = s(victimName);

    if (!killer) return;
    if (isBotName(bot, killer)) return;

    const now = Date.now();
    const recent = bot[RECENT];
    const key = victim ? `${n(killer)}|${n(victim)}` : `${n(killer)}|_`;

    const last = recent.get(key);
    if (last && now - last < 250) return;

    recent.set(key, now);
    pruneRecent(recent, now);

    // self-kills don't count
    if (victim && n(victim) === n(killer)) return;

    const killsMap = bot[KILLS];
    const kk = n(killer);
    const nextKills = (killsMap.get(kk) || 0) + 1;
    killsMap.set(kk, nextKills);

    if (state) {
      const kr = getOrCreatePlayer(state, killer, killer);
      kr.kills = nextKills;
      if (!kr.firstKillAt) kr.firstKillAt = now;
      kr.lastKillAt = now;

      if (victim && !isBotName(bot, victim)) {
        const vr = getOrCreatePlayer(state, victim, victim);
        vr.deaths = Number(vr.deaths || 0) + 1;
        vr.lastSeenAt = now;
      }

      state.updatedAt = now;
    }

    if (Number.isFinite(target) && target > 0 && nextKills >= target) {
      endGame("target");
    }
  };

  for (const evt of events) bot.on?.(evt, handler);

  const extra = [];

  const onPlayerJoin = (p) => {
    if (gameId && s(bot?.game?.id) && s(bot?.game?.id) !== s(gameId)) return;
    if (isBotPlayer(bot, p)) return;

    const nm = playerName(p);
    if (!nm) return;

    const st = ensureGameState(gameId);
    if (!st) return;
    getOrCreatePlayer(st, nm, nm);
    st.updatedAt = Date.now();
  };

  const onPlayerLeave = (p) => {
    if (gameId && s(bot?.game?.id) && s(bot?.game?.id) !== s(gameId)) return;

    const nm = playerName(p) || pickName(p);
    if (!nm) return;

    const st = ensureGameState(gameId);
    if (!st) return;

    const rec = st.players.get(n(nm));
    if (rec) rec.present = false;
    st.updatedAt = Date.now();
  };

  bot.on?.("playerJoin", onPlayerJoin);
  bot.on?.("playerLeave", onPlayerLeave);
  extra.push({ evt: "playerJoin", fn: onPlayerJoin }, { evt: "playerLeave", fn: onPlayerLeave });

  const timers = [];

  const syncTick = () => syncPlayersFromBot(bot, gameId);
  syncTick();
  timers.push(setInterval(syncTick, 2000));

  // Timer starts only after startDeathmatchGame() calls this
  if (Number.isFinite(secs) && secs > 0) {
    timers.push(
      setTimeout(() => {
        endGame("timer");
      }, secs * 1000)
    );
  }

  bot[ARMED] = { gameId: s(gameId), events, handler, extra, timers };
}

/**
 * Called by your Discord "Start Game" button handler.
 * Runs a countdown in-game, then posts the rules line, then starts tracking.
 */
export async function startDeathmatchGame({ gameId, countdownFrom = 3 } = {}) {
  const bot = await ensureBotInstance();

  const gid = s(gameId || bot?.game?.id);
  if (!gid) return { ok: false, reason: "no_game" };

  const state = ensureGameState(gid);
  if (!state) return { ok: false, reason: "state_missing" };

  if (state.startedAt || s(bot?.[ARMED]?.gameId) === gid) {
    return { ok: false, reason: "already_started" };
  }

  if (STARTING_GAMES.has(gid)) {
    return { ok: false, reason: "already_starting" };
  }

  const cfg = WIN_CFG.get(gid);
  const target = Number.isFinite(Number(cfg?.target)) && Number(cfg?.target) > 0 ? Number(cfg.target) : 30;

  const secs =
    Number.isFinite(Number(cfg?.timeLimitSeconds)) && Number(cfg?.timeLimitSeconds) > 0
      ? Number(cfg.timeLimitSeconds)
      : Number(state.configuredTimeLimitSeconds || 600);

  const count = Math.max(1, Number.parseInt(countdownFrom, 10) || 3);

  STARTING_GAMES.add(gid);

  try {
    syncPlayersFromBot(bot, gid);

    // Countdown (no /p)
    chatSafe(bot, "Deathmatch Starting In...");
    await sleep(900);

    for (let i = count; i >= 1; i -= 1) {
      chatSafe(bot, String(i));
      await sleep(900);
    }

    chatSafe(bot, "GO!");

    // Start tracking/timer after countdown
    armDeathmatchTracker(bot, gid, { targetNumber: target, timeLimitSeconds: secs });

    // Small delay so next message doesn't get swallowed
    await sleep(250);

    // Shell chat has a small limit, so split this into two shorter lines
    const minsShort = formatMinutesShortFromSeconds(secs);
    chatSafe(bot, `First to ${target} kills wins!`);
    await sleep(150);
    chatSafe(bot, ` Or most kills at time end wins! | ${minsShort} left`);

    return {
      ok: true,
      gameId: gid,
      target,
      timeLimitSeconds: secs,
      startedAt: GAME_STATE.get(gid)?.startedAt || Date.now(),
    };
  } finally {
    STARTING_GAMES.delete(gid);
  }
}

/**
 * Creates the Deathmatch lobby only.
 * Does NOT start the timer or kill tracking.
 * Your panel "Start Game" button should call startDeathmatchGame({ gameId }).
 */
export async function createDeathmatchGame({
  region = DEFAULT_REGION,
  map = DEFAULT_MAP,
  targetNumber = 30,
  timeLimitSeconds = 600,
} = {}) {
  const bot = await ensureBotInstance();

  const safeRegion = normalizeChoice(region, ALLOWED_REGIONS, DEFAULT_REGION);
  const safeMap = normalizeChoice(map, ALLOWED_MAPS, DEFAULT_MAP);

  const t = Number.parseInt(targetNumber, 10);
  const secs = Number.parseInt(timeLimitSeconds, 10);

  const safeTarget = Number.isFinite(t) && t > 0 ? t : 30;
  const safeSecs = Number.isFinite(secs) && secs > 0 ? secs : 600;

  const game = await bot.createPrivateGame(safeRegion, GameMode.FFA, safeMap);
  const gameId = s(game?.id);

  // Create state but do not start clock yet
  ensureGameState(gameId, { timeLimitSeconds: safeSecs });

  // Save win config so Start Game button knows what to start
  configureDeathmatchWin({ gameId, target: safeTarget, timeLimitSeconds: safeSecs });

  let localHelloSent = false;

  const tryHello = () => {
    if (localHelloSent) return;
    if (HELLO_SENT.has(gameId)) return;
    if (!canBotChat(bot)) return;

    localHelloSent = true;
    HELLO_SENT.add(gameId);

    chatSafe(bot, HELLO_MSG);
  };

  const onPlayerJoin = (player) => {
    if (gameId && s(bot?.game?.id) && s(bot?.game?.id) !== gameId) return;
    if (isBotPlayer(bot, player)) return;

    tryHello();
    safeOff(bot, "playerJoin", onPlayerJoin);
  };

  bot.on?.("playerJoin", onPlayerJoin);

  await bot.join(BOT_NAME, gameId);

  // Keep player list warm pre-game
  syncPlayersFromBot(bot, gameId);

  // Backup poll if playerJoin hook misses
  const start = Date.now();
  const poll = () => {
    if (localHelloSent) return;
    if (HELLO_SENT.has(gameId)) return;
    if (Date.now() - start > 30000) return;

    const humans = getPlayersArray(bot).filter((p) => !isBotPlayer(bot, p));
    if (humans.length) {
      tryHello();
      return;
    }

    setTimeout(poll, 400);
  };
  setTimeout(poll, 400);

  const gameCode = s(bot?.game?.code || game?.code || "");
  const gameLink = gameCode ? `https://shellshock.io/#${gameCode}` : "";

  return { gameId, gameCode, gameLink };
}