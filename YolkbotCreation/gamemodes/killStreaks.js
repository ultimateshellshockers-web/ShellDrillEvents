/** @format */
// gamemodes/killStreaks.js

import { ensureBotInstance } from "../src/yolkbotClient.js";
import { GameMode } from "yolkbot/constants";

const DEFAULT_REGION = "uscentral";
const DEFAULT_MAP = "cluckgrounds";
const BOT_NAME = process.env.YOLKBOT_NAME?.trim() || "Shell Drill Events";
const HELLO_MSG = process.env.KILLSTREAK_HELLO?.trim() || "hi";

// ✅ Announce streaks only every N kills (5, 10, 15, ...)
const STREAK_ANNOUNCE_STEP = 5;

// ✅ Allowed picks (matches eventpanel dropdowns)
const ALLOWED_REGIONS = new Set(["uscentral", "germany"]);
const ALLOWED_MAPS = new Set(["castle", "blue", "growler", "cluckgrounds"]);

// One "hi" per game id (avoid double fires if both join + poll trigger)
const HELLO_SENT = new Set();

// Killstreak arming (avoid double-binding if this factory is called again)
const ARMED = Symbol("killStreaksArmed");
const RECENT = Symbol("killStreaksRecentKills");
const STREAKS = Symbol("killStreaksPerPlayer");

// ✅ Module-level live state for Discord panels
// gameId -> { startedAt, updatedAt, players: Map(key -> { name, streak, best, kills, present, lastSeenAt }) }
const GAME_STATE = new Map();

// ✅ Win configuration + one-time guard
const WIN_CFG = new Map(); // gameId -> { target:number, onWin?:fn, fired:boolean }
const GAME_OVER = new Set(); // gameId

const s = (x) => String(x ?? "").trim();
const n = (x) => s(x).toLowerCase();

function normalizeChoice(value, allowedSet, fallback) {
  const v = n(value);
  return allowedSet.has(v) ? v : fallback;
}

function canBotChat(bot) {
  // must be private OR email verified OR aged
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

function ensureGameState(gameId) {
  const gid = s(gameId);
  if (!gid) return null;
  if (!GAME_STATE.has(gid)) {
    GAME_STATE.set(gid, {
      gameId: gid,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      players: new Map(),
    });
  }
  return GAME_STATE.get(gid);
}

function getOrCreatePlayer(state, key, displayName) {
  const k = n(key);
  if (!state.players.has(k)) {
    state.players.set(k, {
      name: s(displayName) || key,
      streak: 0,
      best: 0,
      kills: 0,
      present: true,
      lastSeenAt: Date.now(),
    });
  } else {
    const rec = state.players.get(k);
    if (displayName && rec?.name !== displayName) rec.name = s(displayName);
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

function unarmKillstreak(bot) {
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

// ✅ Configure the win condition from Discord side
export function configureKillstreakWin({ gameId, target, onWin } = {}) {
  const gid = s(gameId);
  const t = Number.parseInt(target, 10);
  if (!gid) return false;
  if (!Number.isFinite(t) || t <= 0) return false;

  WIN_CFG.set(gid, { target: t, onWin: typeof onWin === "function" ? onWin : null, fired: false });
  GAME_OVER.delete(gid);
  return true;
}

export function getKillstreakFinalSnapshot(gameId) {
  const state = GAME_STATE.get(s(gameId));
  if (!state) return { players: [] };

  const rows = [...state.players.values()]
    .map((p) => ({
      name: s(p.name),
      streak: Number(p.streak || 0),
      best: Number(p.best || 0),
      kills: Number(p.kills || 0),
      present: Boolean(p.present),
    }))
    .filter((p) => p.name)
    .sort((a, b) => {
      if ((b.best || 0) !== (a.best || 0)) return (b.best || 0) - (a.best || 0);
      if ((b.kills || 0) !== (a.kills || 0)) return (b.kills || 0) - (a.kills || 0);
      return a.name.localeCompare(b.name);
    });

  return { players: rows };
}

function armKillstreakAnnouncements(bot, gameId) {
  unarmKillstreak(bot);

  if (!bot[RECENT]) bot[RECENT] = new Map();
  if (!bot[STREAKS]) bot[STREAKS] = new Map();

  const state = ensureGameState(gameId);

  const events = Array.from(
    new Set(["kill", "playerKill", "playerKilled", "killFeed", "death", "playerDeath", "gameKill", "killEvent"])
  );

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
    if (last && now - last < 300) return;

    recent.set(key, now);
    pruneRecent(recent, now);

    const streaks = bot[STREAKS];
    const killerKey = n(killer);

    // suicide/self-kill: reset, no announce
    if (victim && n(victim) === killerKey) {
      streaks.set(killerKey, 0);
      if (state) {
        const pr = getOrCreatePlayer(state, killer, killer);
        pr.streak = 0;
        state.updatedAt = now;
      }
      return;
    }

    const next = (streaks.get(killerKey) || 0) + 1;
    streaks.set(killerKey, next);

    if (victim) {
      const victimKey = n(victim);
      if (!isBotName(bot, victim)) streaks.set(victimKey, 0);
    }

    // update state for Discord
    if (state) {
      const killerRec = getOrCreatePlayer(state, killer, killer);
      killerRec.kills += 1;
      killerRec.streak = next;
      killerRec.best = Math.max(killerRec.best || 0, next);

      if (victim && !isBotName(bot, victim)) {
        const victimRec = getOrCreatePlayer(state, victim, victim);
        victimRec.streak = 0;
      }

      state.updatedAt = now;
    }

    // ✅ check win condition (configured from eventpanel)
    const cfg = WIN_CFG.get(s(gameId));
    const target = Number(cfg?.target || 0);

    if (cfg && !cfg.fired && target > 0 && next >= target) {
      cfg.fired = true;
      GAME_OVER.add(s(gameId));

      try {
        bot.emit("chat", `/p ${killer} has reached ${target} kill streak! GGs to everyone!`);
      } catch {}

      const payload = {
        gameId: s(gameId),
        winnerName: killer,
        target,
        final: getKillstreakFinalSnapshot(gameId),
      };

      if (typeof cfg.onWin === "function") {
        setTimeout(() => {
          Promise.resolve(cfg.onWin(payload)).catch(() => null);
        }, 0);
      }

      setTimeout(() => unarmKillstreak(bot), 250);
      return;
    }

    // ✅ only announce on 5s (5, 10, 15, ...)
    if (next % STREAK_ANNOUNCE_STEP !== 0) return;

    try {
      bot.emit("chat", `${killer} has a ${next} kill streak`);
    } catch {}
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

  bot[ARMED] = { gameId: s(gameId), events, handler, extra, timers };
}

export function getKillstreakSnapshot(gameId, { limit = 10 } = {}) {
  const state = GAME_STATE.get(s(gameId));
  if (!state) {
    return { startedAt: null, updatedAt: null, players: [], leaderboard: [] };
  }

  const present = [...state.players.values()].filter((p) => p?.present);

  const players = present
    .map((p) => s(p.name))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const rows = present
    .slice()
    .sort((a, b) => {
      if ((b.streak || 0) !== (a.streak || 0)) return (b.streak || 0) - (a.streak || 0);
      if ((b.best || 0) !== (a.best || 0)) return (b.best || 0) - (a.best || 0);
      return (b.kills || 0) - (a.kills || 0);
    })
    .slice(0, Math.max(0, limit | 0))
    .map((p) => ({
      name: s(p.name),
      streak: Number(p.streak || 0),
      best: Number(p.best || 0),
      kills: Number(p.kills || 0),
    }));

  return { startedAt: state.startedAt, updatedAt: state.updatedAt, players, leaderboard: rows };
}

/**
 * Creates a Killstreak game (FFA) and returns { gameId, gameCode, gameLink }.
 * Sends "hi" when the first non-bot human joins.
 */
export async function createKillstreakGame({ region = DEFAULT_REGION, map = DEFAULT_MAP } = {}) {
  const bot = await ensureBotInstance();

  // ✅ sanitize inputs (so your bot doesn't get bricked by typo energy)
  const safeRegion = normalizeChoice(region, ALLOWED_REGIONS, DEFAULT_REGION);
  const safeMap = normalizeChoice(map, ALLOWED_MAPS, DEFAULT_MAP);

  const game = await bot.createPrivateGame(safeRegion, GameMode.FFA, safeMap);
  const gameId = s(game?.id);

  ensureGameState(gameId);

  let localHelloSent = false;

  const tryHello = (why) => {
    if (localHelloSent) return;
    if (HELLO_SENT.has(gameId)) return;

    const ok = canBotChat(bot);
    console.log(
      `[killStreaks] hello trigger (${why}) | canChat=${ok} | isPrivate=${!!bot?.game?.isPrivate} | emailVerified=${!!bot?.account?.emailVerified} | isAged=${!!bot?.account?.isAged}`
    );

    if (!ok) return;

    localHelloSent = true;
    HELLO_SENT.add(gameId);

    try {
      bot.emit("chat", HELLO_MSG);
    } catch {}
  };

  const onPlayerJoin = (player) => {
    if (gameId && s(bot?.game?.id) && s(bot?.game?.id) !== gameId) return;
    if (isBotPlayer(bot, player)) return;

    tryHello(`playerJoin:${playerName(player)}`);
    safeOff(bot, "playerJoin", onPlayerJoin);
  };

  bot.on?.("playerJoin", onPlayerJoin);

  await bot.join(BOT_NAME, gameId);

  armKillstreakAnnouncements(bot, gameId);

  const start = Date.now();
  const poll = () => {
    if (localHelloSent) return;
    if (HELLO_SENT.has(gameId)) return;
    if (Date.now() - start > 30000) return;

    const humans = getPlayersArray(bot).filter((p) => !isBotPlayer(bot, p));
    if (humans.length) {
      tryHello("playerListPoll");
      return;
    }

    setTimeout(poll, 400);
  };
  setTimeout(poll, 400);

  const gameCode = s(bot?.game?.code || game?.code || "");
  const gameLink = gameCode ? `https://shellshock.io/#${gameCode}` : "";

  return { gameId, gameCode, gameLink };
}