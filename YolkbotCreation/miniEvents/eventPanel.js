/** @format */
// miniEvents/eventpanel.js

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { query } from "../src/db.js";
import { requireStaffCommand, canRunStaffCommand } from "../staffcommands/botcommands.js";

// --------------------
// postgres storage
// --------------------
let EVENT_PANEL_TABLE_READY = false;

async function ensureEventPanelTable() {
  if (EVENT_PANEL_TABLE_READY) return;

  await query(`
    CREATE TABLE IF NOT EXISTS event_panel_states (
      message_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      panel_type TEXT NOT NULL,
      status TEXT NOT NULL,
      announced_message_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      state_json JSONB NOT NULL
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_event_panel_states_guild_id
    ON event_panel_states (guild_id)
  `);

  EVENT_PANEL_TABLE_READY = true;
}

async function getPanelChannelId(guildId, panelKey) {
  try {
    const res = await query(
      `
      SELECT channel_id
      FROM panel_channels
      WHERE guild_id = $1 AND panel_key = $2
      LIMIT 1
      `,
      [String(guildId), String(panelKey)]
    );

    return res.rows?.[0]?.channel_id ? String(res.rows[0].channel_id) : null;
  } catch {
    return null;
  }
}

async function getStateByMessageId(messageId) {
  await ensureEventPanelTable();

  const res = await query(
    `
    SELECT state_json
    FROM event_panel_states
    WHERE message_id = $1
    LIMIT 1
    `,
    [String(messageId)]
  );

  const raw = res.rows?.[0]?.state_json;
  if (!raw) return null;

  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  return hydrateState(obj);
}

async function getStatesByGuild(guildId) {
  await ensureEventPanelTable();

  const res = await query(
    `
    SELECT state_json
    FROM event_panel_states
    WHERE guild_id = $1
    ORDER BY updated_at DESC
    `,
    [String(guildId)]
  );

  return (res.rows || [])
    .map((r) => (typeof r.state_json === "string" ? JSON.parse(r.state_json) : r.state_json))
    .map((s) => hydrateState(s))
    .filter(Boolean);
}

async function saveState(state) {
  await ensureEventPanelTable();
  const clean = hydrateState(JSON.parse(JSON.stringify(state)));
  if (!clean?.messageId) return;

  await query(
    `
    INSERT INTO event_panel_states (
      message_id,
      guild_id,
      channel_id,
      panel_type,
      status,
      announced_message_id,
      updated_at,
      state_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7::jsonb)
    ON CONFLICT (message_id)
    DO UPDATE SET
      guild_id = EXCLUDED.guild_id,
      channel_id = EXCLUDED.channel_id,
      panel_type = EXCLUDED.panel_type,
      status = EXCLUDED.status,
      announced_message_id = EXCLUDED.announced_message_id,
      updated_at = NOW(),
      state_json = EXCLUDED.state_json
    `,
    [
      String(clean.messageId),
      String(clean.guildId || ""),
      String(clean.channelId || ""),
      String(clean.panelType || "staff"),
      String(clean.status || "setup"),
      clean.announcedMessageId ? String(clean.announcedMessageId) : null,
      JSON.stringify(clean),
    ]
  );
}

// --------------------
// map / server options (staff picks)
// --------------------
const DEFAULT_REGION = "uscentral";
const DEFAULT_MAP = "cluckgrounds";

const ALLOWED_REGIONS = new Set(["uscentral", "germany"]);
const ALLOWED_MAPS = new Set(["castle", "blue", "growler", "cluckgrounds"]);

// --------------------
// permissions (centralized, adminpanel is parent)
// --------------------
const STAFF_EVENT_CMD = "eventpanel";
const STAFF_CONTROL_CMD = "controlevent";

function canUseEventPanel(member) {
  return canRunStaffCommand(member, STAFF_EVENT_CMD);
}

function canUseControlPanel(member) {
  // allow explicit controlevent OR eventpanel permission
  return canRunStaffCommand(member, STAFF_CONTROL_CMD) || canRunStaffCommand(member, STAFF_EVENT_CMD);
}

function canSpawnLivePanel(member) {
  // allow staff (via adminpanel parent) OR people with mod perms to spawn the live message
  if (canUseEventPanel(member)) return true;

  const perms = member?.permissions;
  if (!perms) return false;

  return (
    perms.has(PermissionsBitField.Flags.Administrator) ||
    perms.has(PermissionsBitField.Flags.ManageGuild) ||
    perms.has(PermissionsBitField.Flags.ManageMessages)
  );
}

// --------------------
// live stats panel runtime (in-memory)
// guildId -> { gameId, eventKey, channelId, messageId, timer, startedAt, timeLimitSeconds }
// --------------------
const LIVE_PANELS = new Map();

// --------------------
// control panel runtime (in-memory)
// controlMessageId -> { guildId, channelId, messageId, mode, selectedMap, selectedRegion }
// --------------------
const CONTROL_PANELS = new Map();

// --------------------
// live snapshots
// --------------------
const s = (x) => String(x ?? "").trim();

async function tryGetKillstreakSnapshot(gameId, { limit = 10 } = {}) {
  try {
    const mod = await import("../gamemodes/killStreaks.js");
    const fn = mod?.getKillstreakSnapshot;
    if (typeof fn !== "function") return null;
    return fn(String(gameId ?? "").trim(), { limit });
  } catch {
    return null;
  }
}

async function importDeathmatchModule() {
  // tolerant of casing differences across environments
  try {
    return await import("../gamemodes/deathmatch.js");
  } catch {}
  try {
    return await import("../gamemodes/deathmatch.js");
  } catch {}
  return null;
}

async function tryGetDeathmatchSnapshot(gameId, { limit = 10 } = {}) {
  try {
    const mod = await importDeathmatchModule();
    const fn = mod?.getDeathmatchSnapshot;
    if (typeof fn !== "function") return null;
    return fn(String(gameId ?? "").trim(), { limit });
  } catch {
    return null;
  }
}

// --------------------
// yolkbot runtime / lobby helpers (best-effort adapters)
// --------------------
async function importYolkbotIndexModule() {
  try {
    return await import("../src/yolkbotIndex.js");
  } catch {
    return null;
  }
}

async function tryGetActiveLobbyForGuildControl(guildId) {
  try {
    const mod = await importYolkbotIndexModule();
    const fn = mod?.getActiveLobbyForGuild;
    if (typeof fn !== "function") return null;
    return fn(String(guildId ?? "").trim());
  } catch {
    return null;
  }
}

async function tryGetActiveLobbyByGameIdControl(gameId) {
  try {
    const mod = await importYolkbotIndexModule();
    const fn = mod?.getActiveLobbyByGameId;
    if (typeof fn !== "function") return null;
    return fn(String(gameId ?? "").trim());
  } catch {
    return null;
  }
}

function getLobbyGameId(lobby) {
  return (
    s(lobby?.gameId) ||
    s(lobby?.id) ||
    s(lobby?.game?.gameId) ||
    s(lobby?.game?.id) ||
    s(lobby?.room?.gameId) ||
    s(lobby?.room?.id)
  );
}

function detectLobbyLocked(lobby) {
  if (!lobby || typeof lobby !== "object") return null;

  const direct =
    lobby.isLocked ??
    lobby.locked ??
    lobby?.game?.isLocked ??
    lobby?.game?.locked ??
    lobby?.room?.isLocked ??
    lobby?.room?.locked ??
    lobby?.settings?.locked;

  if (typeof direct === "boolean") return direct;
  return null;
}

function countLobbyPlayers(lobby) {
  const arr =
    (Array.isArray(lobby?.players) && lobby.players) ||
    (Array.isArray(lobby?.game?.players) && lobby.game.players) ||
    (Array.isArray(lobby?.room?.players) && lobby.room.players) ||
    null;

  return Array.isArray(arr) ? arr.length : null;
}

function getLobbyPlayerNames(lobby) {
  const arr =
    (Array.isArray(lobby?.players) && lobby.players) ||
    (Array.isArray(lobby?.game?.players) && lobby.game.players) ||
    (Array.isArray(lobby?.room?.players) && lobby.room.players) ||
    [];

  return arr
    .map((p) => s(p?.name || p?.playerName || p?.username || p))
    .filter(Boolean);
}

async function getEventModuleForKey(eventKey) {
  if (eventKey === "killstreak") {
    try {
      return await import("../gamemodes/killStreaks.js");
    } catch {
      return null;
    }
  }
  if (eventKey === "deathmatch") return importDeathmatchModule();
  return null;
}

async function tryCallNamed(mod, names, payload) {
  if (!mod) return { ok: false, reason: "no_module" };

  for (const name of names) {
    try {
      const fn = mod?.[name];
      if (typeof fn !== "function") continue;

      const res = await fn(payload);
      if (res === false) continue;
      return { ok: true, res, fn: name };
    } catch {
      // try next
    }
  }

  return { ok: false, reason: "no_fn" };
}

async function trySendGameChatForEvent(publicState, text) {
  const eventKey = s(publicState?.selectedEventKey);
  const gameId = s(publicState?.settings?.gameId);
  const guildId = s(publicState?.guildId);
  if (!eventKey || !gameId || !text) return { ok: false, reason: "bad_args" };

  const mod = await getEventModuleForKey(eventKey);

  // module-level adapters
  {
    const attempt = await tryCallNamed(
      mod,
      [
        "sendKillstreakChatMessage",
        "sendDeathmatchChatMessage",
        "sendGameChatMessage",
        "sendInGameChat",
        "sendGameChat",
        "chatGame",
      ],
      { gameId, message: text, text }
    );
    if (attempt.ok) return attempt;
  }

  // lobby-level adapters
  const lobby = (await tryGetActiveLobbyByGameIdControl(gameId)) || (await tryGetActiveLobbyForGuildControl(guildId));
  if (lobby && getLobbyGameId(lobby) === gameId) {
    const fns = [
      lobby.sendChat,
      lobby.chat,
      lobby?.bot?.sendChat,
      lobby?.bot?.chat,
      lobby?.game?.sendChat,
      lobby?.game?.chat,
    ].filter((fn) => typeof fn === "function");

    for (const fn of fns) {
      try {
        await fn.call(lobby, text);
        return { ok: true, fn: "lobby.chat" };
      } catch {
        try {
          await fn.call(lobby?.bot || lobby?.game, text);
          return { ok: true, fn: "bot.chat" };
        } catch {}
      }
    }
  }

  return { ok: false, reason: "unsupported" };
}

async function trySetLobbyLockForEvent(publicState, locked) {
  const eventKey = s(publicState?.selectedEventKey);
  const gameId = s(publicState?.settings?.gameId);
  const guildId = s(publicState?.guildId);
  if (!eventKey || !gameId || typeof locked !== "boolean") return { ok: false, reason: "bad_args" };

  const mod = await getEventModuleForKey(eventKey);

  // module-level adapters
  {
    const attempt = await tryCallNamed(
      mod,
      [
        "setKillstreakLobbyLocked",
        "setDeathmatchLobbyLocked",
        "setLobbyLocked",
        "setGameLocked",
        "toggleLobbyLock",
      ],
      { gameId, locked }
    );
    if (attempt.ok) return attempt;
  }

  // explicit lock/unlock funcs
  if (mod) {
    try {
      const fn = locked
        ? mod.lockKillstreakLobby || mod.lockDeathmatchLobby || mod.lockLobby || mod.lockGame
        : mod.unlockKillstreakLobby || mod.unlockDeathmatchLobby || mod.unlockLobby || mod.unlockGame;
      if (typeof fn === "function") {
        const res = await fn({ gameId });
        return { ok: true, res, fn: locked ? "lock*" : "unlock*" };
      }
    } catch {}
  }

  // lobby-level adapters
  const lobby = (await tryGetActiveLobbyByGameIdControl(gameId)) || (await tryGetActiveLobbyForGuildControl(guildId));
  if (lobby && getLobbyGameId(lobby) === gameId) {
    const methodCandidates = [
      { obj: lobby, fn: "setLocked", args: [locked] },
      { obj: lobby.game, fn: "setLocked", args: [locked] },
      { obj: lobby.room, fn: "setLocked", args: [locked] },
      { obj: lobby, fn: locked ? "lock" : "unlock", args: [] },
      { obj: lobby.game, fn: locked ? "lock" : "unlock", args: [] },
      { obj: lobby.room, fn: locked ? "lock" : "unlock", args: [] },
    ];

    for (const c of methodCandidates) {
      try {
        if (typeof c?.obj?.[c.fn] !== "function") continue;
        await c.obj[c.fn](...(c.args || []));
        return { ok: true, fn: `lobby.${c.fn}` };
      } catch {}
    }
  }

  return { ok: false, reason: "unsupported" };
}

async function tryKickPlayerForEvent(publicState, playerName) {
  const eventKey = s(publicState?.selectedEventKey);
  const gameId = s(publicState?.settings?.gameId);
  const guildId = s(publicState?.guildId);
  const player = s(playerName);
  if (!eventKey || !gameId || !player) return { ok: false, reason: "bad_args" };

  const mod = await getEventModuleForKey(eventKey);

  // module-level adapters
  {
    const attempt = await tryCallNamed(
      mod,
      ["kickKillstreakPlayer", "kickDeathmatchPlayer", "kickPlayer", "bootPlayer", "removePlayer"],
      { gameId, playerName: player, name: player, player }
    );
    if (attempt.ok) return attempt;
  }

  // lobby-level adapters
  const lobby = (await tryGetActiveLobbyByGameIdControl(gameId)) || (await tryGetActiveLobbyForGuildControl(guildId));
  if (lobby && getLobbyGameId(lobby) === gameId) {
    const names = getLobbyPlayerNames(lobby);
    const exact = names.find((n) => n.toLowerCase() === player.toLowerCase()) || player;

    const methodCandidates = [
      { obj: lobby, fn: "kickPlayer", args: [exact] },
      { obj: lobby, fn: "bootPlayer", args: [exact] },
      { obj: lobby.game, fn: "kickPlayer", args: [exact] },
      { obj: lobby.room, fn: "kickPlayer", args: [exact] },
      { obj: lobby, fn: "removePlayer", args: [exact] },
      { obj: lobby.game, fn: "removePlayer", args: [exact] },
    ];

    for (const c of methodCandidates) {
      try {
        if (typeof c?.obj?.[c.fn] !== "function") continue;
        await c.obj[c.fn](...(c.args || []));
        return { ok: true, fn: `lobby.${c.fn}`, player: exact };
      } catch {}
    }
  }

  return { ok: false, reason: "unsupported" };
}

async function tryResetEventRuntime(publicState) {
  const eventKey = s(publicState?.selectedEventKey);
  const gameId = s(publicState?.settings?.gameId);
  const guildId = s(publicState?.guildId);
  if (!eventKey || !gameId) return { ok: false, reason: "bad_args" };

  const mod = await getEventModuleForKey(eventKey);

  // module-level adapters
  {
    const attempt = await tryCallNamed(
      mod,
      ["resetKillstreakGame", "resetDeathmatchGame", "resetGame", "restartGame", "resetMatch"],
      { gameId }
    );
    if (attempt.ok) return attempt;
  }

  // lobby-level adapters
  const lobby = (await tryGetActiveLobbyByGameIdControl(gameId)) || (await tryGetActiveLobbyForGuildControl(guildId));
  if (lobby && getLobbyGameId(lobby) === gameId) {
    const methodCandidates = [
      { obj: lobby, fn: "resetGame", args: [] },
      { obj: lobby, fn: "reset", args: [] },
      { obj: lobby.game, fn: "resetGame", args: [] },
      { obj: lobby.game, fn: "reset", args: [] },
      { obj: lobby.room, fn: "resetGame", args: [] },
    ];

    for (const c of methodCandidates) {
      try {
        if (typeof c?.obj?.[c.fn] !== "function") continue;
        await c.obj[c.fn](...(c.args || []));
        return { ok: true, fn: `lobby.${c.fn}` };
      } catch {}
    }
  }

  return { ok: false, reason: "unsupported" };
}

// --------------------
// time helpers
// --------------------
function nowIso() {
  return new Date().toISOString();
}

function fmtTime(seconds) {
  const s0 = Number(seconds);
  if (!Number.isFinite(s0) || s0 <= 0) return null;
  const m = Math.floor(s0 / 60);
  const r = s0 % 60;
  if (m <= 0) return `${r}s`;
  if (r === 0) return `${m}m`;
  return `${m}m ${r}s`;
}

function fmtClock(seconds) {
  const s0 = Number(seconds);
  if (!Number.isFinite(s0) || s0 < 0) return null;
  const m = Math.floor(s0 / 60);
  const r = s0 % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function secondsSinceIso(iso) {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return null;
  const diff = Date.now() - t;
  return Math.max(0, Math.floor(diff / 1000));
}

// Discord timestamp helpers:
// <t:unix:R> => relative (live-updating “pill”)
// <t:unix:T> => exact time (localized)
function toUnixSeconds(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 1000);
}

function parseIsoToMs(iso) {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? t : 0;
}

function computeDeathmatchEndsAtMs({ snap, startedAt, timeLimitSeconds } = {}) {
  // Prefer gamemode absolute endsAt if provided
  const endsAt = Number(snap?.endsAt || 0);
  if (Number.isFinite(endsAt) && endsAt > 0) return endsAt;

  // Fallback: panel startedAt + timeLimitSeconds
  const startMs = parseIsoToMs(startedAt);
  const limit = Number(timeLimitSeconds || 0);
  if (startMs > 0 && Number.isFinite(limit) && limit > 0) return startMs + limit * 1000;

  return 0;
}

function safeKd(kills, deaths) {
  const k = Number(kills || 0);
  const d = Number(deaths || 0);
  if (!Number.isFinite(k) || !Number.isFinite(d)) return null;
  if (d <= 0) return k > 0 ? "∞" : "0.00";
  return (k / d).toFixed(2);
}

// --------------------
// live embed builders
// --------------------
async function buildKillstreakLiveStatsEmbed(gameId) {
  const gid = String(gameId ?? "").trim();
  const snap = await tryGetKillstreakSnapshot(gid, { limit: 10 });

  const embed = new EmbedBuilder().setTitle("Killstreak Live Stats");

  if (!snap) {
    embed.addFields({ name: "Players", value: "—", inline: false });
    embed.addFields({ name: "Streaks", value: "—", inline: false });
    return embed;
  }

  const playersVal = snap.players?.length ? snap.players.map((p) => `• ${p}`).join("\n") : "—";

  const streakLines =
    snap.leaderboard?.length > 0
      ? snap.leaderboard
          .filter((p) => (p.kills || 0) > 0 || (p.streak || 0) > 0)
          .map((p, i) => {
            const rank = String(i + 1).padStart(2, "0");
            return `**${rank}. ${p.name}**  | streak: **${p.streak}** | best: ${p.best} | kills: ${p.kills}`;
          })
      : [];

  const streakVal = streakLines.length ? streakLines.join("\n") : "—";

  embed.addFields(
    { name: "Players", value: playersVal, inline: false },
    { name: "Streaks", value: streakVal, inline: false }
  );

  return embed;
}

async function buildDeathmatchLiveStatsEmbed(gameId, { startedAt = null, timeLimitSeconds = null } = {}) {
  const gid = String(gameId ?? "").trim();
  const snap = await tryGetDeathmatchSnapshot(gid, { limit: 10 });

  const embed = new EmbedBuilder().setTitle("Deathmatch Live Stats");

  // Countdown (Discord live timestamps)
  const endsAtMs = computeDeathmatchEndsAtMs({ snap, startedAt, timeLimitSeconds });
  if (endsAtMs > 0) {
    const unix = toUnixSeconds(endsAtMs);
    const leftSec = Math.max(0, Math.round((endsAtMs - Date.now()) / 1000));

    const timeVal =
      leftSec <= 0
        ? `**Ended:** <t:${unix}:R>\n**Ended at:** <t:${unix}:T>`
        : `**Remaining:** <t:${unix}:R>\n**Ends at:** <t:${unix}:T>`;

    embed.addFields({ name: "Time Remaining", value: timeVal, inline: true });
    embed.addFields({ name: "\u200B", value: "\u200B", inline: true });
    embed.addFields({ name: "\u200B", value: "\u200B", inline: true });
  }

  if (!snap) {
    embed.addFields({ name: "Players", value: "—", inline: false });
    embed.addFields({ name: "Leaderboard", value: "—", inline: false });
    return embed;
  }

  const playersVal = snap.players?.length ? snap.players.map((p) => `• ${p}`).join("\n") : "—";

  const rowsRaw = Array.isArray(snap.leaderboard) ? snap.leaderboard : Array.isArray(snap.players) ? snap.players : [];

  const rows = rowsRaw
    .map((p) => ({
      name: String(p?.name ?? p?.player ?? p?.playerName ?? "").trim(),
      kills: Number(p?.kills || 0),
      deaths: p?.deaths == null ? null : Number(p?.deaths || 0),
    }))
    .filter((p) => p.name);

  rows.sort((a, b) => {
    if (b.kills !== a.kills) return b.kills - a.kills;
    const ad = a.deaths == null ? Infinity : a.deaths;
    const bd = b.deaths == null ? Infinity : b.deaths;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name);
  });

  const lines =
    rows.length > 0
      ? rows.slice(0, 10).map((p, i) => {
          const rank = String(i + 1).padStart(2, "0");
          const deathsStr = p.deaths == null ? "—" : String(p.deaths);
          const kdStr = p.deaths == null ? "—" : safeKd(p.kills, p.deaths);
          return `**${rank}. ${p.name}** | kills: **${p.kills}** | deaths: ${deathsStr} | K/D: ${kdStr}`;
        })
      : [];

  embed.addFields(
    { name: "Players", value: playersVal, inline: false },
    { name: "Leaderboard", value: lines.length ? lines.join("\n") : "—", inline: false }
  );

  return embed;
}

// --------------------
// live panel runtime
// --------------------
async function startOrReuseLivePanel(interaction, gameId, { eventKey, startedAt = null, timeLimitSeconds = null } = {}) {
  const guildId = String(interaction.guildId ?? "").trim();
  const channelId = String(interaction.channelId ?? "").trim();
  if (!guildId || !channelId) return;

  const gid = String(gameId ?? "").trim();
  if (!gid) return;

  const existing = LIVE_PANELS.get(guildId);
  if (existing?.gameId === gid && existing?.eventKey === eventKey) {
    const url = `https://discord.com/channels/${guildId}/${existing.channelId}/${existing.messageId}`;
    await interaction.reply({ content: `Live stats panel already running:\n${url}`, ephemeral: true }).catch(() => null);
    return;
  }

  if (existing?.timer) clearInterval(existing.timer);

  const firstEmbed =
    eventKey === "deathmatch"
      ? await buildDeathmatchLiveStatsEmbed(gid, { startedAt, timeLimitSeconds })
      : await buildKillstreakLiveStatsEmbed(gid);

  const msg = await interaction.channel?.send?.({ embeds: [firstEmbed] }).catch(() => null);

  if (!msg) {
    await interaction.reply({ content: "Couldn't create a live panel in this channel.", ephemeral: true }).catch(() => null);
    return;
  }

  const timer = setInterval(async () => {
    try {
      const e =
        eventKey === "deathmatch"
          ? await buildDeathmatchLiveStatsEmbed(gid, { startedAt, timeLimitSeconds })
          : await buildKillstreakLiveStatsEmbed(gid);
      await msg.edit({ embeds: [e] });
    } catch {
      clearInterval(timer);
    }
  }, 5000);

  LIVE_PANELS.set(guildId, {
    gameId: gid,
    eventKey,
    channelId,
    messageId: msg.id,
    timer,
    startedAt: startedAt || null,
    timeLimitSeconds: timeLimitSeconds ?? null,
  });

  const url = `https://discord.com/channels/${guildId}/${channelId}/${msg.id}`;
  await interaction.reply({ content: `Live stats panel created:\n${url}`, ephemeral: true }).catch(() => null);
}

async function stopAndDeleteLivePanelIfMatches(client, guildId, gameId) {
  const gId = String(guildId ?? "").trim();
  const gid = String(gameId ?? "").trim();
  if (!gId || !gid) return;

  const lp = LIVE_PANELS.get(gId);
  if (!lp || lp.gameId !== gid) return;

  try {
    if (lp.timer) clearInterval(lp.timer);
  } catch {}

  try {
    const ch = await client.channels.fetch(lp.channelId).catch(() => null);
    const m = ch?.isTextBased?.() ? await ch.messages.fetch(lp.messageId).catch(() => null) : null;
    if (m) await m.delete().catch(() => null);
  } catch {}

  LIVE_PANELS.delete(gId);
}

// --------------------
// final results embed (trophy line + aligned player lines)
// --------------------
function norm(x) {
  return s(x).toLowerCase();
}

function buildKillstreakFinalEmbed({ winnerName, target, final }) {
  const w = s(winnerName);
  const t = Number(target || 0);

  const rows = Array.isArray(final?.players) ? final.players : [];

  const sorted = rows
    .map((p) => ({
      name: s(p?.name),
      best: Number(p?.best || 0),
      kills: Number(p?.kills || 0),
    }))
    .filter((p) => p.name)
    .sort((a, b) => b.best - a.best || b.kills - a.kills || a.name.localeCompare(b.name));

  const winnerRow = sorted.find((p) => w && norm(p.name) === norm(w)) || { name: w || "Unknown", best: 0, kills: 0 };

  const title = t > 0 ? `Killstreak Results (First to ${t})` : "Killstreak Results";

  const lines = [];
  lines.push(`🏆 **${winnerRow.name}** | **WINNER** | best: **${winnerRow.best}** | kills: **${winnerRow.kills}**`);

  let place = 2;
  for (const p of sorted) {
    if (w && norm(p.name) === norm(w)) continue;
    lines.push(`${place}. ${p.name} | best: ${p.best} | kills: ${p.kills}`);
    place += 1;
  }

  if (!sorted.length) lines.push(`2. — | best: 0 | kills: 0`);

  return new EmbedBuilder().setTitle(title).setDescription(lines.join("\n"));
}

function buildDeathmatchFinalEmbed({ winnerName, target, timeLimitSeconds, final, reason }) {
  const w = s(winnerName);
  const t = Number(target || 0);
  const secs = Number(timeLimitSeconds || 0);

  const rows = Array.isArray(final?.players) ? final.players : [];

  const sorted = rows
    .map((p) => ({
      name: s(p?.name),
      kills: Number(p?.kills || 0),
      deaths: Number(p?.deaths || 0),
    }))
    .filter((p) => p.name)
    .sort((a, b) => {
      if (b.kills !== a.kills) return b.kills - a.kills;
      if (a.deaths !== b.deaths) return a.deaths - b.deaths;
      return a.name.localeCompare(b.name);
    });

  const winnerRow = sorted.find((p) => w && norm(p.name) === norm(w)) || { name: w || "Unknown", kills: 0, deaths: 0 };

  const timeStr = fmtTime(secs);
  const titleParts = ["Deathmatch Results"];
  if (t > 0) titleParts.push(`First to ${t}`);
  if (timeStr) titleParts.push(timeStr);
  const title = titleParts.length > 1 ? `${titleParts[0]} (${titleParts.slice(1).join(" • ")})` : titleParts[0];

  const byLine = reason === "target" ? `reached **${t}** kills first` : ``;
  const winnerKd = safeKd(winnerRow.kills, winnerRow.deaths);

  const lines = [];
  lines.push(
    `🏆 **${winnerRow.name}** | **WINNER** | kills: **${winnerRow.kills}** | deaths: **${winnerRow.deaths}** | K/D: **${winnerKd}**${byLine ? ` (${byLine})` : ""}`
  );

  let place = 2;
  for (const p of sorted) {
    if (w && norm(p.name) === norm(w)) continue;
    const kd = safeKd(p.kills, p.deaths);
    lines.push(`${place}. ${p.name} | kills: ${p.kills} | deaths: ${p.deaths} | K/D: ${kd}`);
    place += 1;
  }

  if (!sorted.length) lines.push(`2. — | kills: 0 | deaths: 0 | K/D: 0.00`);

  return new EmbedBuilder().setTitle(title).setDescription(lines.join("\n"));
}

function parseFirstInt(text) {
  const t = String(text ?? "");
  const m = t.match(/(\d{1,6})/);
  if (!m) return null;
  const v = Number.parseInt(m[1], 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// --------------------
// mini events (base model)
// --------------------
const MINI_EVENTS = {
  killstreak: {
    key: "killstreak",
    label: "Killstreak",
    baseHowToWin: (s0) => `Reach ${s0?.targetNumber ?? "X"} kills in a row (no deaths) to win.`,
    baseRules: ["Any guns allowed unless staff restricts it.", "Staff may add weapon limits, maps, or other restrictions."],
    defaults: { targetNumber: 10, timeLimitSeconds: null },
    canAutoCreate: true,
  },

  deathmatch: {
    key: "deathmatch",
    label: "Deathmatch",
    baseHowToWin: (s0) => {
      const t = s0?.targetNumber ?? "X";
      const timeStr = fmtTime(s0?.timeLimitSeconds);
      return `First to ${t} kills wins. If time runs out${timeStr ? ` (${timeStr})` : ""}, the player with the most kills wins.`;
    },
    baseRules: ["Any guns allowed unless staff restricts it."],
    defaults: { targetNumber: 30, timeLimitSeconds: 600 },
    canAutoCreate: true,
  },

  battle_royale: {
    key: "battle_royale",
    label: "Battle Royale",
    baseHowToWin: () => "Be the last player standing.",
    baseRules: ["Active zones will push toward the middle for a final fight.", "Any guns allowed unless staff restricts it."],
    defaults: { targetNumber: null, timeLimitSeconds: null },
    canAutoCreate: false,
  },

  hide_seek: {
    key: "hide_seek",
    label: "Hide & Seek",
    baseHowToWin: () => "Last one alive wins.",
    baseRules: ["All players hide.", "A staff member will be the seeker (or staff decides).", "Last survivor wins."],
    defaults: { targetNumber: null, timeLimitSeconds: null },
    canAutoCreate: false,
  },
};

const EVENT_KEYS = Object.keys(MINI_EVENTS);

// --------------------
// state helpers
// --------------------
function makeNewState({ guildId, channelId, messageId, panelType = "staff" }) {
  return {
    guildId,
    channelId,
    messageId,
    panelType,
    status: "setup", // setup | running | ended
    selectedEventKey: null,
    settings: {
      gameLink: "",
      gameId: "",
      targetNumber: null,
      timeLimitSeconds: null,
      howToWinOverride: "",
      rulesOverride: "",
      region: DEFAULT_REGION,
      map: DEFAULT_MAP,
      controlLobbyLocked: null,
      endedReason: null,
      endedAt: null,
    },
    announcedChannelId: null,
    announcedMessageId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    startedBy: null,
  };
}

function cloneForPublic(state, { channelId }) {
  return {
    ...state,
    channelId,
    messageId: "pending",
    panelType: "public",
    status: "running",
    announcedChannelId: null,
    announcedMessageId: null,
    startedAt: state.startedAt || null,
    startedBy: state.startedBy || null,
    updatedAt: nowIso(),
  };
}

function hydrateState(state) {
  if (!state || typeof state !== "object") return null;
  if (!state.settings || typeof state.settings !== "object") state.settings = {};

  if (!state.panelType) state.panelType = "staff";
  if (!state.status) state.status = "setup";

  if (typeof state.settings.gameLink !== "string") state.settings.gameLink = "";
  if (typeof state.settings.gameId !== "string") state.settings.gameId = "";

  if (state.settings.targetNumber === undefined) state.settings.targetNumber = null;
  if (state.settings.timeLimitSeconds === undefined) state.settings.timeLimitSeconds = null;

  if (typeof state.settings.howToWinOverride !== "string") state.settings.howToWinOverride = "";
  if (typeof state.settings.rulesOverride !== "string") state.settings.rulesOverride = "";

  if (typeof state.settings.region !== "string" || !ALLOWED_REGIONS.has(state.settings.region)) {
    state.settings.region = DEFAULT_REGION;
  }
  if (typeof state.settings.map !== "string" || !ALLOWED_MAPS.has(state.settings.map)) {
    state.settings.map = DEFAULT_MAP;
  }

  if (state.settings.controlLobbyLocked === undefined) state.settings.controlLobbyLocked = null;
  if (state.settings.endedReason === undefined) state.settings.endedReason = null;
  if (state.settings.endedAt === undefined) state.settings.endedAt = null;

  if (typeof state.startedAt !== "string") state.startedAt = state.startedAt || null;
  if (typeof state.startedBy !== "string") state.startedBy = state.startedBy || null;

  return state;
}

function normalizeStateForEvent(state) {
  const ev = state?.selectedEventKey ? MINI_EVENTS[state.selectedEventKey] : null;
  if (!ev) return state;

  if (state.settings.targetNumber == null && ev.defaults.targetNumber != null) state.settings.targetNumber = ev.defaults.targetNumber;
  if (state.settings.timeLimitSeconds == null && ev.defaults.timeLimitSeconds != null) {
    state.settings.timeLimitSeconds = ev.defaults.timeLimitSeconds;
  }

  return state;
}

function getHowToWinText(state) {
  const ev = MINI_EVENTS[state.selectedEventKey];
  const override = String(state.settings.howToWinOverride ?? "").trim();
  if (override) return override;
  return ev.baseHowToWin(state.settings);
}

function getRulesText(state) {
  const ev = MINI_EVENTS[state.selectedEventKey];
  const override = String(state.settings.rulesOverride ?? "").trim();
  if (override) return override;

  const rules = [...ev.baseRules];
  const t = fmtTime(state.settings.timeLimitSeconds);
  if (t) rules.push(`Time limit: ${t}`);

  return rules.map((x) => `• ${x}`).join("\n");
}

function getRemindersText() {
  return [
    "• Players with Must Screenshare and/or Hacker Tagged must screenshare their gameplay",
    "↳ Failure to comply will result in not participating.",
    "• Event Hostess and Owners cannot win their own event",
    "↳ If an owner is participating in an event hosted by an Event Hostess, that is allowed.",
  ].join("\n");
}

function isValidHttpUrlMaybeEmpty(s0) {
  const t = String(s0 ?? "").trim();
  if (!t) return true;
  return /^https?:\/\//i.test(t);
}

// --------------------
// game auto-create (Killstreak + Deathmatch)
// --------------------
async function autoCreateGameForEvent(
  eventKey,
  { region = DEFAULT_REGION, map = DEFAULT_MAP, targetNumber = null, timeLimitSeconds = null, forceNew = false, remake = false } = {}
) {
  if (!eventKey) throw new Error("No event selected.");

  if (eventKey === "killstreak") {
    const mod = await import("../gamemodes/killStreaks.js");
    const fn = mod?.createKillstreakGame;
    if (typeof fn !== "function") throw new Error("createKillstreakGame() not found in gamemodes/killStreaks.js");
    const res = await fn({
      region,
      map,
      forceNew: Boolean(forceNew),
      remake: Boolean(remake),
    });
    const gameId = String(res?.gameId ?? "").trim();
    const gameLink = String(res?.gameLink ?? "").trim();
    if (!gameLink) throw new Error("Game created but no link was returned.");
    return { gameId, gameLink };
  }

  if (eventKey === "deathmatch") {
    const mod = await importDeathmatchModule();
    const fn = mod?.createDeathmatchGame;
    if (typeof fn !== "function") throw new Error("createDeathmatchGame() not found in gamemodes/deathMatch.js");

    const res = await fn({
      region,
      map,
      targetNumber: Number(targetNumber) || 30,
      timeLimitSeconds: Number(timeLimitSeconds) || 600,
      forceNew: Boolean(forceNew),
      remake: Boolean(remake),
    });

    const gameId = String(res?.gameId ?? "").trim();
    const gameLink = String(res?.gameLink ?? "").trim();
    if (!gameLink) throw new Error("Game created but no link was returned.");
    return { gameId, gameLink };
  }

  throw new Error("Auto-create is not implemented for this event yet.");
}

// --------------------
// active event detection (ignores stale DB rows)
// --------------------
async function isPublicStateActuallyLive(publicState) {
  if (!publicState) return false;

  const evKey = String(publicState?.selectedEventKey ?? "").trim();
  const gameId = String(publicState?.settings?.gameId ?? "").trim();
  const guildId = String(publicState?.guildId ?? "").trim();

  if (!evKey || !gameId || !guildId) return false;
  if (String(publicState?.status ?? "") !== "running") return false;

  // strongest signal: active lobby registry
  try {
    const lobby = await tryGetActiveLobbyForGuildControl(guildId);
    const lobbyGameId = getLobbyGameId(lobby);
    if (lobbyGameId && lobbyGameId === gameId) return true;
  } catch {}

  // supported snapshots
  if (evKey === "killstreak") {
    const snap = await tryGetKillstreakSnapshot(gameId, { limit: 1 }).catch(() => null);
    if (snap) return true;
    return false;
  }

  if (evKey === "deathmatch") {
    const snap = await tryGetDeathmatchSnapshot(gameId, { limit: 1 }).catch(() => null);
    if (snap) return true;

    const startedMs = parseIsoToMs(publicState?.startedAt);
    const limitSec = Number(publicState?.settings?.timeLimitSeconds || 0);
    if (startedMs > 0 && limitSec > 0) {
      const hardEndMs = startedMs + limitSec * 1000 + 120000;
      if (Date.now() > hardEndMs) return false;
    }

    return false;
  }

  // unsupported/manual events: freshness fallback
  const updatedMs = parseIsoToMs(publicState?.updatedAt || publicState?.createdAt);
  if (updatedMs > 0) {
    const ageMs = Date.now() - updatedMs;
    if (ageMs > 6 * 60 * 60 * 1000) return false;
  }

  return true;
}

async function getActiveEventBundleByGuild(guildId) {
  const states = await getStatesByGuild(guildId);

  const publics = (states || [])
    .filter(
      (st) =>
        st &&
        st.panelType === "public" &&
        st.status === "running" &&
        st.selectedEventKey &&
        String(st?.settings?.gameId ?? "").trim()
    )
    .sort((a, b) => {
      const ta = Date.parse(String(a.updatedAt ?? a.createdAt ?? "")) || 0;
      const tb = Date.parse(String(b.updatedAt ?? b.createdAt ?? "")) || 0;
      return tb - ta;
    });

  for (const publicState of publics) {
    const isLive = await isPublicStateActuallyLive(publicState);
    if (!isLive) continue;

    const staffState =
      (states || []).find(
        (st) =>
          st &&
          st.panelType === "staff" &&
          String(st.announcedMessageId ?? "") === String(publicState.messageId ?? "")
      ) || null;

    return { publicState, staffState };
  }

  return null;
}

async function closeRunningEventByPublicState(client, publicState, { reason = "ended" } = {}) {
  if (!publicState) return;

  const guildId = String(publicState.guildId ?? "").trim();
  const gameId = String(publicState?.settings?.gameId ?? "").trim();

  if (guildId && gameId) {
    await stopAndDeleteLivePanelIfMatches(client, guildId, gameId).catch(() => null);
  }

  publicState.status = "ended";
  publicState.settings = publicState.settings || {};
  publicState.settings.endedReason = reason;
  publicState.settings.endedAt = nowIso();
  publicState.updatedAt = nowIso();
  await saveState(publicState);

  const guildStates = await getStatesByGuild(guildId);
  for (const st of guildStates) {
    if (!st || st.panelType !== "staff") continue;
    if (String(st.announcedMessageId ?? "") !== String(publicState.messageId ?? "")) continue;

    st.status = "ended";
    st.settings = st.settings || {};
    st.settings.endedReason = reason;
    st.settings.endedAt = nowIso();
    st.updatedAt = nowIso();
    await saveState(st);

    await updatePanelMessage(client, st).catch(() => null);
  }

  await updatePanelMessage(client, publicState).catch(() => null);
}

// --------------------
// win detection wiring (used on start + remake)
// --------------------
async function wireWinDetectionForRunningEvent(client, { guildId, publicState, announceChannel }) {
  if (!publicState || !announceChannel) return;

  const evKey = String(publicState.selectedEventKey ?? "").trim();
  const gameId = String(publicState?.settings?.gameId ?? "").trim();
  if (!evKey || !gameId) return;

  if (evKey === "killstreak") {
    const howTo = getHowToWinText(publicState);
    const parsed = parseFirstInt(howTo);
    const target = parsed ?? (Number(publicState.settings.targetNumber) || 10);

    publicState.settings.targetNumber = target;
    publicState.updatedAt = nowIso();
    await saveState(publicState);

    const guildStates = await getStatesByGuild(guildId);
    for (const st of guildStates) {
      if (!st || st.panelType !== "staff") continue;
      if (String(st.announcedMessageId ?? "") !== String(publicState.messageId)) continue;
      st.settings.targetNumber = target;
      st.updatedAt = nowIso();
      await saveState(st);
      await updatePanelMessage(client, st).catch(() => null);
    }

    const mod = await import("../gamemodes/killStreaks.js");
    const cfg0 = mod?.configureKillstreakWin;

    if (typeof cfg0 === "function") {
      cfg0({
        gameId,
        target,
        onWin: async ({ winnerName, target, final }) => {
          await closeRunningEventByPublicState(client, publicState, { reason: "completed" });
          const finEmbed = buildKillstreakFinalEmbed({ winnerName, target, final });
          await announceChannel.send({ embeds: [finEmbed] }).catch(() => null);
        },
      });
    }
  }

  if (evKey === "deathmatch") {
    const target = Number(publicState.settings.targetNumber) || 30;
    const timeLimitSeconds = Number(publicState.settings.timeLimitSeconds) || 600;

    const mod = await importDeathmatchModule();
    const cfg0 = mod?.configureDeathmatchWin;

    if (typeof cfg0 === "function") {
      cfg0({
        gameId,
        target,
        timeLimitSeconds,
        onWin: async ({ winnerName, target, timeLimitSeconds, final, reason }) => {
          await closeRunningEventByPublicState(client, publicState, { reason: "completed" });
          const finEmbed = buildDeathmatchFinalEmbed({ winnerName, target, timeLimitSeconds, final, reason });
          await announceChannel.send({ embeds: [finEmbed] }).catch(() => null);
        },
      });
    }
  }
}

// --------------------
// UI builders (event panels)
// --------------------
function buildMapSelectRow(state) {
  const disabled = !state.selectedEventKey;

  const menu = new StringSelectMenuBuilder()
    .setCustomId("evp:map")
    .setPlaceholder("Select map")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(disabled)
    .addOptions(
      [...ALLOWED_MAPS].map((m) => ({
        label: m,
        value: m,
        default: String(state?.settings?.map ?? DEFAULT_MAP) === m,
      }))
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildRegionSelectRow(state) {
  const disabled = !state.selectedEventKey;

  const menu = new StringSelectMenuBuilder()
    .setCustomId("evp:region")
    .setPlaceholder("Select server")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(disabled)
    .addOptions(
      [...ALLOWED_REGIONS].map((r) => ({
        label: r,
        value: r,
        default: String(state?.settings?.region ?? DEFAULT_REGION) === r,
      }))
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildSetupEmbed(state) {
  const selected = state.selectedEventKey ? MINI_EVENTS[state.selectedEventKey] : null;

  if (!selected) {
    return new EmbedBuilder().setTitle("Mini Event Panel").setDescription("Select a mini event below.");
  }

  const e = new EmbedBuilder().setTitle(`${selected.label} Event`);

  e.addFields(
    { name: "Map", value: String(state.settings.map || DEFAULT_MAP), inline: true },
    { name: "Server", value: String(state.settings.region || DEFAULT_REGION), inline: true },
    { name: "\u200B", value: "\u200B", inline: true },
    { name: "How to Win", value: getHowToWinText(state), inline: false },
    { name: "Rules", value: getRulesText(state), inline: false },
    { name: "Reminders", value: getRemindersText(), inline: false }
  );

  return e;
}

function buildPublicEmbed(state) {
  const selected = MINI_EVENTS[state.selectedEventKey];

  const e = new EmbedBuilder().setTitle(`${selected.label} Event`).addFields(
    { name: "Map", value: String(state.settings.map || DEFAULT_MAP), inline: true },
    { name: "Server", value: String(state.settings.region || DEFAULT_REGION), inline: true },
    { name: "\u200B", value: "\u200B", inline: true },
    { name: "How to Win", value: getHowToWinText(state), inline: false },
    { name: "Rules", value: getRulesText(state), inline: false },
    { name: "Reminders", value: getRemindersText(), inline: false }
  );

  if (state.status === "ended") {
    const reason = s(state?.settings?.endedReason) || "ended";
    e.addFields({ name: "Status", value: `Closed (${reason})`, inline: false });
  }

  return e;
}

function buildStaffLockedEmbed(state) {
  const selected = MINI_EVENTS[state.selectedEventKey];
  const where = state.announcedChannelId ? `<#${state.announcedChannelId}>` : "the announcement channel";

  const e = new EmbedBuilder().setTitle(selected ? `${selected.label} Event` : "Mini Event Panel");

  if (state.status === "ended") {
    const reason = s(state?.settings?.endedReason) || "ended";
    e.addFields({ name: "Status", value: `Event closed (${reason}).`, inline: false });
  } else {
    e.addFields({ name: "Announcement", value: `Event posted in ${where}.`, inline: false });
  }

  if (selected) {
    e.addFields(
      { name: "Map", value: String(state.settings.map || DEFAULT_MAP), inline: true },
      { name: "Server", value: String(state.settings.region || DEFAULT_REGION), inline: true },
      { name: "\u200B", value: "\u200B", inline: true },
      { name: "How to Win", value: getHowToWinText(state), inline: false },
      { name: "Rules", value: getRulesText(state), inline: false },
      { name: "Reminders", value: getRemindersText(), inline: false }
    );
  }

  return e;
}

function buildComponents(state) {
  // Public panel
  if (state.panelType === "public") {
    if (state.status !== "running") return [];

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("evp:join").setLabel("Join Event").setStyle(ButtonStyle.Success)
    );

    const hasGameId = Boolean(String(state.settings.gameId ?? "").trim());
    const canShowLive = (state.selectedEventKey === "killstreak" || state.selectedEventKey === "deathmatch") && hasGameId;

    if (canShowLive) {
      row.addComponents(new ButtonBuilder().setCustomId("evp:livestats").setLabel("Live Stats").setStyle(ButtonStyle.Secondary));

      if (state.selectedEventKey === "deathmatch") {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId("evp:startgame")
            .setLabel(state.startedAt ? "Game Started" : "Start Game")
            .setStyle(ButtonStyle.Danger)
            .setDisabled(Boolean(state.startedAt))
        );
      }
    }

    return [row];
  }

  // Staff panel locked/ended
  if (state.panelType === "staff" && state.status !== "setup") return [];

  // Staff setup panel
  const pickRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("evp:pick:killstreak").setLabel("Killstreak").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("evp:pick:deathmatch").setLabel("Deathmatch").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("evp:pick:battle_royale").setLabel("Battle Royale").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("evp:pick:hide_seek").setLabel("Hide & Seek").setStyle(ButtonStyle.Primary)
  );

  const canStart = !!state.selectedEventKey;

  const controlRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("evp:edit").setLabel("Edit Rules").setStyle(ButtonStyle.Secondary).setDisabled(!state.selectedEventKey),
    new ButtonBuilder().setCustomId("evp:start").setLabel("Start Event").setStyle(ButtonStyle.Danger).setDisabled(!canStart),
    new ButtonBuilder().setCustomId("evp:join").setLabel("Join Event").setStyle(ButtonStyle.Success).setDisabled(true)
  );

  const mapRow = buildMapSelectRow(state);
  const regionRow = buildRegionSelectRow(state);

  return [pickRow, mapRow, regionRow, controlRow];
}

async function updatePanelMessage(client, state) {
  const channel = await client.channels.fetch(state.channelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return false;

  const msg = await channel.messages.fetch(state.messageId).catch(() => null);
  if (!msg) return false;

  let embed;

  if (state.panelType === "staff") {
    embed = state.status === "setup" ? buildSetupEmbed(state) : buildStaffLockedEmbed(state);
  } else {
    embed = buildPublicEmbed(state);
  }

  const components = buildComponents(state);
  await msg.edit({ embeds: [embed], components }).catch(() => null);
  return true;
}

// --------------------
// modal (event setup)
// --------------------
function buildEditModal(state) {
  const ev = MINI_EVENTS[state.selectedEventKey];

  const modal = new ModalBuilder().setCustomId(`evp:modal:${state.messageId}`).setTitle(`${ev.label} Settings`);

  const linkInput = new TextInputBuilder()
    .setCustomId("gameLink")
    .setLabel("Game Link (optional, bot can create)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("Leave blank to auto-create")
    .setValue(state.settings.gameLink?.slice(0, 200) || "");

  const targetInput = new TextInputBuilder()
    .setCustomId("targetNumber")
    .setLabel("Target Number (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("Example: 10")
    .setValue(state.settings.targetNumber != null ? String(state.settings.targetNumber) : "");

  const timeInput = new TextInputBuilder()
    .setCustomId("timeLimitSeconds")
    .setLabel("Time Limit in Seconds (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("Example: 600")
    .setValue(state.settings.timeLimitSeconds != null ? String(state.settings.timeLimitSeconds) : "");

  const howToWinOverride = new TextInputBuilder()
    .setCustomId("howToWinOverride")
    .setLabel("How to Win (optional override)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder("Leave blank to use the default for this event.")
    .setValue(state.settings.howToWinOverride?.slice(0, 1000) || "");

  const rulesOverride = new TextInputBuilder()
    .setCustomId("rulesOverride")
    .setLabel("Rules (optional override)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder("Leave blank to use the default rules for this event.")
    .setValue(state.settings.rulesOverride?.slice(0, 1000) || "");

  modal.addComponents(
    new ActionRowBuilder().addComponents(linkInput),
    new ActionRowBuilder().addComponents(targetInput),
    new ActionRowBuilder().addComponents(timeInput),
    new ActionRowBuilder().addComponents(howToWinOverride),
    new ActionRowBuilder().addComponents(rulesOverride)
  );

  return modal;
}

function parseOptionalInt(s0, { min = 1, max = 999999 } = {}) {
  const t = String(s0 ?? "").trim();
  if (!t) return null;
  const n = Number.parseInt(t, 10);
  if (!Number.isFinite(n)) return null;
  if (n < min) return null;
  if (n > max) return null;
  return n;
}

// --------------------
// control panel UI + actions
// --------------------
function makeControlPanelState({ guildId, channelId, messageId }) {
  return {
    guildId: String(guildId ?? "").trim(),
    channelId: String(channelId ?? "").trim(),
    messageId: String(messageId ?? "").trim(),
    mode: "main", // main | remake
    selectedMap: null,
    selectedRegion: null,
    updatedAt: nowIso(),
  };
}

async function getControlRuntime(publicState) {
  if (!publicState) return null;

  const gameId = s(publicState?.settings?.gameId);
  const guildId = s(publicState?.guildId);
  const evKey = s(publicState?.selectedEventKey);

  const lobby = (await tryGetActiveLobbyByGameIdControl(gameId)) || (await tryGetActiveLobbyForGuildControl(guildId));
  const matchedLobby = lobby && getLobbyGameId(lobby) === gameId ? lobby : null;

  let snap = null;
  if (evKey === "killstreak") snap = await tryGetKillstreakSnapshot(gameId, { limit: 25 });
  if (evKey === "deathmatch") snap = await tryGetDeathmatchSnapshot(gameId, { limit: 25 });

  const playerCountFromSnap = Array.isArray(snap?.players) ? snap.players.length : null;
  const playerCount = playerCountFromSnap ?? countLobbyPlayers(matchedLobby) ?? 0;

  let timer = "Not started";
  if (evKey === "deathmatch") {
    if (!publicState.startedAt) {
      timer = "Waiting";
    } else {
      const endsAtMs = computeDeathmatchEndsAtMs({
        snap,
        startedAt: publicState.startedAt,
        timeLimitSeconds: publicState?.settings?.timeLimitSeconds,
      });
      if (endsAtMs > 0) {
        const left = Math.max(0, Math.round((endsAtMs - Date.now()) / 1000));
        timer = left > 0 ? `Running • ${fmtClock(left)}` : "Ended";
      } else {
        const sec = secondsSinceIso(publicState.startedAt);
        timer = `Running • ${fmtClock(sec || 0)}`;
      }
    }
  } else {
    const sec = secondsSinceIso(publicState.startedAt);
    timer = publicState.startedAt ? `Running • ${fmtClock(sec || 0)}` : "Running";
  }

  const lockState = detectLobbyLocked(matchedLobby);
  const storedLock = typeof publicState?.settings?.controlLobbyLocked === "boolean" ? publicState.settings.controlLobbyLocked : null;
  const lobbyLocked = typeof lockState === "boolean" ? lockState : storedLock;

  return {
    gameId,
    eventKey: evKey,
    playerCount,
    timer,
    lobbyLocked,
    snapshot: snap,
    lobby: matchedLobby,
  };
}

function buildControlEmbed({ bundle, runtime, controlState }) {
  const e = new EmbedBuilder().setTitle("Event Control");

  if (!bundle?.publicState) {
    e.setDescription("There is no event playing.");
    return e;
  }

  const pub = bundle.publicState;
  const eventLabel = MINI_EVENTS[pub.selectedEventKey]?.label || pub.selectedEventKey || "Unknown";
  const statusLabel = pub.status === "running" ? "In Progress" : pub.status === "ended" ? "Ended" : "Idle";
  const lobbyLabel =
    runtime && typeof runtime.lobbyLocked === "boolean" ? (runtime.lobbyLocked ? "Locked" : "Unlocked") : "Unknown";

  const targetText = pub.settings.targetNumber != null ? String(pub.settings.targetNumber) : "—";
  const timeLimitText =
    pub.settings.timeLimitSeconds != null ? fmtTime(pub.settings.timeLimitSeconds) || `${pub.settings.timeLimitSeconds}s` : "—";
  const playersText = String(runtime?.playerCount ?? 0);
  const timerText = runtime?.timer || "—";

  e.setDescription("Staff controls for the active event.");

  e.addFields(
    { name: "Event", value: eventLabel, inline: true },
    { name: "Status", value: statusLabel, inline: true },
    { name: "Lobby", value: lobbyLabel, inline: true },

    { name: "Map", value: String(pub.settings.map || DEFAULT_MAP), inline: true },
    { name: "Server", value: String(pub.settings.region || DEFAULT_REGION), inline: true },
    { name: "Timer", value: timerText, inline: true },

    { name: "Target", value: targetText, inline: true },
    { name: "Time Limit", value: timeLimitText, inline: true },
    { name: "Players", value: playersText, inline: true }
  );

  if (controlState?.mode === "remake") {
    const nextMap = controlState.selectedMap || pub.settings.map || DEFAULT_MAP;
    const nextRegion = controlState.selectedRegion || pub.settings.region || DEFAULT_REGION;
    e.addFields({
      name: "Remake Draft",
      value: `Map: ${nextMap}\nServer: ${nextRegion}`,
      inline: false,
    });
  }

  return e;
}

function buildControlComponents({ bundle, runtime, controlState }) {
  if (!bundle?.publicState) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("evc:refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary)
      ),
    ];
  }

  const isRemake = controlState?.mode === "remake";
  const pub = bundle.publicState;

  if (isRemake) {
    const mapMenu = new StringSelectMenuBuilder()
      .setCustomId("evc:remake:map")
      .setPlaceholder("Select map")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        [...ALLOWED_MAPS].map((m) => ({
          label: m,
          value: m,
          default: String(controlState.selectedMap || pub.settings.map || DEFAULT_MAP) === m,
        }))
      );

    const regionMenu = new StringSelectMenuBuilder()
      .setCustomId("evc:remake:region")
      .setPlaceholder("Select server")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        [...ALLOWED_REGIONS].map((r) => ({
          label: r,
          value: r,
          default: String(controlState.selectedRegion || pub.settings.region || DEFAULT_REGION) === r,
        }))
      );

    const row1 = new ActionRowBuilder().addComponents(mapMenu);
    const row2 = new ActionRowBuilder().addComponents(regionMenu);
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("evc:remake:confirm").setLabel("Confirm Remake").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("evc:remake:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("evc:refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary)
    );

    return [row1, row2, row3];
  }

  const lockLabel =
    runtime && typeof runtime.lobbyLocked === "boolean"
      ? runtime.lobbyLocked
        ? "Unlock Lobby"
        : "Lock Lobby"
      : "Lock Lobby";

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("evc:refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("evc:reset").setLabel("Reset Event").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("evc:remake").setLabel("Remake Event").setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("evc:kick").setLabel("Kick or Boot Player").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("evc:chat").setLabel("Send In-Game Message").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("evc:locktoggle").setLabel(lockLabel).setStyle(ButtonStyle.Secondary)
  );

  return [row1, row2];
}

async function renderControlPanelMessage(client, controlState) {
  const cp = controlState;
  if (!cp?.guildId || !cp?.channelId || !cp?.messageId) return false;

  const channel = await client.channels.fetch(cp.channelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return false;

  const msg = await channel.messages.fetch(cp.messageId).catch(() => null);
  if (!msg) return false;

  const bundle = await getActiveEventBundleByGuild(cp.guildId);
  const runtime = bundle?.publicState ? await getControlRuntime(bundle.publicState) : null;

  const embed = buildControlEmbed({ bundle, runtime, controlState: cp });
  const components = buildControlComponents({ bundle, runtime, controlState: cp });

  await msg.edit({ embeds: [embed], components }).catch(() => null);
  return true;
}

async function sendControlPanelMessage(client, message) {
  const guildId = String(message.guild?.id ?? "").trim();
  if (!guildId) return;

  const bundle = await getActiveEventBundleByGuild(guildId);
  const runtime = bundle?.publicState ? await getControlRuntime(bundle.publicState) : null;

  const temp = makeControlPanelState({
    guildId,
    channelId: message.channel.id,
    messageId: "pending",
  });

  const sent = await message.channel
    .send({
      embeds: [buildControlEmbed({ bundle, runtime, controlState: temp })],
      components: buildControlComponents({ bundle, runtime, controlState: temp }),
    })
    .catch(() => null);

  if (!sent) return null;

  const cp = makeControlPanelState({
    guildId,
    channelId: message.channel.id,
    messageId: sent.id,
  });

  CONTROL_PANELS.set(sent.id, cp);
  return sent;
}

// --------------------
// remake/reset helpers (unchanged)
// --------------------
async function remakeRunningEvent(client, publicState, { region, map, actorUserId = null }) {
  if (!publicState) throw new Error("No active event.");
  const evKey = s(publicState.selectedEventKey);
  if (!evKey) throw new Error("Missing event type.");

  const oldGameId = s(publicState?.settings?.gameId);

  const created = await autoCreateGameForEvent(evKey, {
    region: region || publicState.settings.region || DEFAULT_REGION,
    map: map || publicState.settings.map || DEFAULT_MAP,
    targetNumber: publicState.settings.targetNumber,
    timeLimitSeconds: publicState.settings.timeLimitSeconds,
    forceNew: true,
    remake: true,
  });

  publicState.settings.gameId = s(created.gameId);
  publicState.settings.gameLink = s(created.gameLink);
  publicState.settings.region = region || publicState.settings.region || DEFAULT_REGION;
  publicState.settings.map = map || publicState.settings.map || DEFAULT_MAP;
  publicState.settings.controlLobbyLocked = null;

  if (evKey === "deathmatch") {
    publicState.startedAt = null;
    publicState.startedBy = null;
  } else {
    publicState.startedAt = nowIso();
    publicState.startedBy = actorUserId || null;
  }

  publicState.updatedAt = nowIso();
  await saveState(publicState);

  const guildStates = await getStatesByGuild(publicState.guildId);
  let staffState = null;
  for (const st of guildStates) {
    if (!st || st.panelType !== "staff") continue;
    if (String(st.announcedMessageId ?? "") !== String(publicState.messageId)) continue;

    st.settings.gameId = publicState.settings.gameId;
    st.settings.gameLink = publicState.settings.gameLink;
    st.settings.region = publicState.settings.region;
    st.settings.map = publicState.settings.map;
    st.settings.controlLobbyLocked = null;
    st.startedAt = publicState.startedAt;
    st.startedBy = publicState.startedBy;
    st.updatedAt = nowIso();
    await saveState(st);
    staffState = st;
    await updatePanelMessage(client, st).catch(() => null);
  }

  await updatePanelMessage(client, publicState).catch(() => null);
  if (oldGameId) await stopAndDeleteLivePanelIfMatches(client, publicState.guildId, oldGameId).catch(() => null);

  const announceChannel = await client.channels.fetch(publicState.channelId).catch(() => null);
  if (announceChannel?.isTextBased?.()) {
    await wireWinDetectionForRunningEvent(client, {
      guildId: publicState.guildId,
      publicState,
      announceChannel,
    });
  }

  return { publicState, staffState };
}

async function resetRunningEvent(client, publicState, actorUserId = null) {
  if (!publicState) throw new Error("No active event.");
  const evKey = s(publicState.selectedEventKey);

  const resetRes = await tryResetEventRuntime(publicState);

  // If no reset function exists, fallback to a remake on same settings.
  if (!resetRes?.ok) {
    await remakeRunningEvent(client, publicState, {
      region: publicState.settings.region,
      map: publicState.settings.map,
      actorUserId,
    });
    return { mode: "remake_fallback" };
  }

  publicState.settings.controlLobbyLocked = null;

  if (evKey === "deathmatch") {
    publicState.startedAt = null;
    publicState.startedBy = null;
  } else {
    publicState.startedAt = nowIso();
    publicState.startedBy = actorUserId || null;
  }

  publicState.updatedAt = nowIso();
  await saveState(publicState);

  const guildStates = await getStatesByGuild(publicState.guildId);
  for (const st of guildStates) {
    if (!st || st.panelType !== "staff") continue;
    if (String(st.announcedMessageId ?? "") !== String(publicState.messageId)) continue;

    st.settings.controlLobbyLocked = null;
    st.startedAt = publicState.startedAt;
    st.startedBy = publicState.startedBy;
    st.updatedAt = nowIso();
    await saveState(st);
    await updatePanelMessage(client, st).catch(() => null);
  }

  await updatePanelMessage(client, publicState).catch(() => null);

  const announceChannel = await client.channels.fetch(publicState.channelId).catch(() => null);
  if (announceChannel?.isTextBased?.()) {
    await wireWinDetectionForRunningEvent(client, {
      guildId: publicState.guildId,
      publicState,
      announceChannel,
    });
  }

  return { mode: "reset", resetRes };
}

// --------------------
// public register
// --------------------
export function registerEventPanel(client, { prefix = "-" } = {}) {
  ensureEventPanelTable().catch((e) => {
    console.error("[miniEvents] failed to ensure event_panel_states table:", e);
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!message.guild) return;
      if (message.author?.bot) return;

      const content = String(message.content ?? "");
      if (!content.startsWith(prefix)) return;

      const cmd = String(content.slice(prefix.length).trim().split(/\s+/)[0] || "").toLowerCase();
      if (!cmd) return;

      if (cmd !== "eventpanel" && cmd !== "controlevent") return;

      // Central gate (adminpanel parent should grant this once botcommands.js has the parent line)
      const ok = await requireStaffCommand(message, prefix, cmd);
      if (!ok) return;

      if (cmd === "eventpanel") {
        let targetChannel = message.channel;
        const configuredId = await getPanelChannelId(message.guild.id, "eventpanel");
        if (configuredId) {
          const fetched = await message.guild.channels.fetch(configuredId).catch(() => null);
          if (fetched?.isTextBased?.()) targetChannel = fetched;
        }

        const state = makeNewState({
          guildId: message.guild.id,
          channelId: targetChannel.id,
          messageId: "pending",
          panelType: "staff",
        });

        const panelMessage = await targetChannel.send({
          embeds: [buildSetupEmbed(state)],
          components: buildComponents(state),
        });

        state.messageId = panelMessage.id;
        state.updatedAt = nowIso();

        await saveState(state);

        await message.reply(`Setup panel posted${targetChannel.id !== message.channel.id ? ` in ${targetChannel}.` : "."}`).catch(() => null);
        return;
      }

      if (cmd === "controlevent") {
        const sent = await sendControlPanelMessage(client, message);
        if (!sent) {
          await message.reply("Couldn't create the control panel.").catch(() => null);
        }
        return;
      }
    } catch (e) {
      console.error("[miniEvents] MessageCreate error:", e);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // --------------------
      // CONTROL PANEL SELECT MENUS
      // --------------------
      if (interaction.isStringSelectMenu() && interaction.customId?.startsWith("evc:")) {
        if (!interaction.inGuild?.() || !canUseControlPanel(interaction.member)) {
          await interaction.reply({ content: "Staff-only controls.", ephemeral: true }).catch(() => null);
          return;
        }

        const cp = CONTROL_PANELS.get(interaction.message?.id);
        if (!cp) {
          await interaction.reply({ content: "Control panel expired. Run -controlevent again.", ephemeral: true }).catch(() => null);
          return;
        }

        if (interaction.customId === "evc:remake:map") {
          const chosen = String(interaction.values?.[0] ?? "").trim();
          if (!ALLOWED_MAPS.has(chosen)) {
            await interaction.reply({ content: "Invalid map.", ephemeral: true }).catch(() => null);
            return;
          }
          cp.mode = "remake";
          cp.selectedMap = chosen;
          cp.updatedAt = nowIso();
          CONTROL_PANELS.set(cp.messageId, cp);

          await interaction.deferUpdate().catch(() => null);
          await renderControlPanelMessage(client, cp);
          return;
        }

        if (interaction.customId === "evc:remake:region") {
          const chosen = String(interaction.values?.[0] ?? "").trim();
          if (!ALLOWED_REGIONS.has(chosen)) {
            await interaction.reply({ content: "Invalid server.", ephemeral: true }).catch(() => null);
            return;
          }
          cp.mode = "remake";
          cp.selectedRegion = chosen;
          cp.updatedAt = nowIso();
          CONTROL_PANELS.set(cp.messageId, cp);

          await interaction.deferUpdate().catch(() => null);
          await renderControlPanelMessage(client, cp);
          return;
        }

        return;
      }

      // --------------------
      // EVENT PANEL SELECT MENUS
      // --------------------
      if (interaction.isStringSelectMenu()) {
        const { customId } = interaction;
        if (customId !== "evp:map" && customId !== "evp:region") return;

        const msgId = interaction.message?.id;
        const state = msgId ? await getStateByMessageId(msgId) : null;

        if (!state) {
          await interaction.reply({ content: "Panel state missing. Repost with -eventpanel.", ephemeral: true }).catch(() => null);
          return;
        }

        if (!interaction.inGuild?.() || !canUseEventPanel(interaction.member)) {
          await interaction.reply({ content: "Staff-only controls.", ephemeral: true }).catch(() => null);
          return;
        }

        if (state.panelType !== "staff" || state.status !== "setup") {
          await interaction.reply({ content: "This panel can’t be edited right now.", ephemeral: true }).catch(() => null);
          return;
        }

        const chosen = String(interaction.values?.[0] ?? "").trim();

        if (customId === "evp:map") {
          if (!ALLOWED_MAPS.has(chosen)) {
            await interaction.reply({ content: "Invalid map.", ephemeral: true }).catch(() => null);
            return;
          }
          state.settings.map = chosen;
        }

        if (customId === "evp:region") {
          if (!ALLOWED_REGIONS.has(chosen)) {
            await interaction.reply({ content: "Invalid server.", ephemeral: true }).catch(() => null);
            return;
          }
          state.settings.region = chosen;
        }

        state.updatedAt = nowIso();
        await saveState(state);

        await interaction.deferUpdate().catch(() => null);
        await updatePanelMessage(client, state);
        return;
      }

      // --------------------
      // BUTTONS
      // --------------------
      if (interaction.isButton()) {
        const { customId } = interaction;

        // CONTROL PANEL BUTTONS
        if (customId?.startsWith("evc:")) {
          if (!interaction.inGuild?.() || !canUseControlPanel(interaction.member)) {
            await interaction.reply({ content: "Staff-only controls.", ephemeral: true }).catch(() => null);
            return;
          }

          const cp = CONTROL_PANELS.get(interaction.message?.id);
          if (!cp) {
            await interaction.reply({ content: "Control panel expired. Run -controlevent again.", ephemeral: true }).catch(() => null);
            return;
          }

          if (customId === "evc:refresh") {
            cp.updatedAt = nowIso();
            CONTROL_PANELS.set(cp.messageId, cp);

            await interaction.deferUpdate().catch(() => null);
            await renderControlPanelMessage(client, cp);
            return;
          }

          const bundle = await getActiveEventBundleByGuild(interaction.guildId);

          if (!bundle?.publicState) {
            await interaction.reply({ content: "There is no event playing.", ephemeral: true }).catch(() => null);
            await renderControlPanelMessage(client, cp).catch(() => null);
            return;
          }

          const publicState = bundle.publicState;
          const runtime = await getControlRuntime(publicState);

          if (customId === "evc:remake") {
            cp.mode = "remake";
            cp.selectedMap = s(publicState?.settings?.map) || DEFAULT_MAP;
            cp.selectedRegion = s(publicState?.settings?.region) || DEFAULT_REGION;
            cp.updatedAt = nowIso();
            CONTROL_PANELS.set(cp.messageId, cp);

            await interaction.deferUpdate().catch(() => null);
            await renderControlPanelMessage(client, cp);
            return;
          }

          if (customId === "evc:remake:cancel") {
            cp.mode = "main";
            cp.selectedMap = null;
            cp.selectedRegion = null;
            cp.updatedAt = nowIso();
            CONTROL_PANELS.set(cp.messageId, cp);

            await interaction.deferUpdate().catch(() => null);
            await renderControlPanelMessage(client, cp);
            return;
          }

          if (customId === "evc:remake:confirm") {
            await interaction.deferReply({ ephemeral: true }).catch(() => null);

            try {
              const nextMap = cp.selectedMap || publicState.settings.map || DEFAULT_MAP;
              const nextRegion = cp.selectedRegion || publicState.settings.region || DEFAULT_REGION;

              await remakeRunningEvent(client, publicState, {
                map: nextMap,
                region: nextRegion,
                actorUserId: interaction.user?.id ?? null,
              });

              cp.mode = "main";
              cp.selectedMap = null;
              cp.selectedRegion = null;
              cp.updatedAt = nowIso();
              CONTROL_PANELS.set(cp.messageId, cp);

              await renderControlPanelMessage(client, cp).catch(() => null);
              await interaction.editReply({ content: "Event remade with a fresh lobby." }).catch(() => null);
            } catch (e) {
              await interaction.editReply({ content: `Remake failed: ${String(e?.message ?? e)}` }).catch(() => null);
            }
            return;
          }

          if (customId === "evc:reset") {
            await interaction.deferReply({ ephemeral: true }).catch(() => null);

            try {
              const result = await resetRunningEvent(client, publicState, interaction.user?.id ?? null);
              cp.mode = "main";
              cp.selectedMap = null;
              cp.selectedRegion = null;
              cp.updatedAt = nowIso();
              CONTROL_PANELS.set(cp.messageId, cp);

              await renderControlPanelMessage(client, cp).catch(() => null);

              if (result?.mode === "remake_fallback") {
                await interaction
                  .editReply({ content: "Reset isn't supported by this gamemode runtime, so the event was remade instead." })
                  .catch(() => null);
              } else {
                await interaction.editReply({ content: "Event reset." }).catch(() => null);
              }
            } catch (e) {
              await interaction.editReply({ content: `Reset failed: ${String(e?.message ?? e)}` }).catch(() => null);
            }
            return;
          }

          if (customId === "evc:kick") {
            const modal = new ModalBuilder().setCustomId(`evc:modal:kick:${cp.messageId}`).setTitle("Kick or Boot Player");

            const nameInput = new TextInputBuilder()
              .setCustomId("playerName")
              .setLabel("Player Name")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder("Exact player name");

            modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
            await interaction.showModal(modal).catch(() => null);
            return;
          }

          if (customId === "evc:chat") {
            const modal = new ModalBuilder().setCustomId(`evc:modal:chat:${cp.messageId}`).setTitle("Send In-Game Message");

            const msgInput = new TextInputBuilder()
              .setCustomId("chatMessage")
              .setLabel("Message")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(180)
              .setPlaceholder("Message to send in game chat");

            modal.addComponents(new ActionRowBuilder().addComponents(msgInput));
            await interaction.showModal(modal).catch(() => null);
            return;
          }

          if (customId === "evc:locktoggle") {
            await interaction.deferReply({ ephemeral: true }).catch(() => null);

            const currentLocked =
              typeof runtime?.lobbyLocked === "boolean"
                ? runtime.lobbyLocked
                : typeof publicState?.settings?.controlLobbyLocked === "boolean"
                ? publicState.settings.controlLobbyLocked
                : false;

            const nextLocked = !currentLocked;
            const lockRes = await trySetLobbyLockForEvent(publicState, nextLocked);

            if (!lockRes?.ok) {
              await interaction
                .editReply({ content: "Couldn't change lobby lock state. The gamemode runtime doesn't expose a lock/unlock hook yet." })
                .catch(() => null);
              return;
            }

            publicState.settings.controlLobbyLocked = nextLocked;
            publicState.updatedAt = nowIso();
            await saveState(publicState);

            const guildStates = await getStatesByGuild(publicState.guildId);
            for (const st of guildStates) {
              if (!st || st.panelType !== "staff") continue;
              if (String(st.announcedMessageId ?? "") !== String(publicState.messageId)) continue;
              st.settings.controlLobbyLocked = nextLocked;
              st.updatedAt = nowIso();
              await saveState(st);
            }

            cp.updatedAt = nowIso();
            CONTROL_PANELS.set(cp.messageId, cp);
            await renderControlPanelMessage(client, cp).catch(() => null);

            await interaction.editReply({ content: nextLocked ? "Lobby locked." : "Lobby unlocked." }).catch(() => null);
            return;
          }

          await interaction.reply({ content: "Unknown control action.", ephemeral: true }).catch(() => null);
          return;
        }

        // EVENT PANEL BUTTONS
        if (!customId?.startsWith("evp:")) return;

        const msgId = interaction.message?.id;
        const state = msgId ? await getStateByMessageId(msgId) : null;

        if (!state) {
          await interaction.reply({ content: "Panel state missing. Repost with -eventpanel.", ephemeral: true }).catch(() => null);
          return;
        }

        // JOIN (public panel)
        if (customId === "evp:join") {
          if (state.status !== "running" || state.panelType !== "public") {
            await interaction.reply({ content: "This panel is not accepting joins.", ephemeral: true }).catch(() => null);
            return;
          }
          if (!state.settings.gameLink?.trim()) {
            await interaction.reply({ content: "No link is set for this event yet.", ephemeral: true }).catch(() => null);
            return;
          }
          await interaction.reply({ content: state.settings.gameLink.trim(), ephemeral: true }).catch(() => null);
          return;
        }

        // LIVE STATS (public killstreak + deathmatch)
        if (customId === "evp:livestats") {
          if (state.status !== "running" || state.panelType !== "public") {
            await interaction.reply({ content: "Live stats are only available on the announcement panel.", ephemeral: true }).catch(() => null);
            return;
          }

          const evKey = String(state.selectedEventKey ?? "").trim();
          if (evKey !== "killstreak" && evKey !== "deathmatch") {
            await interaction.reply({ content: "Live stats aren’t supported for this event yet.", ephemeral: true }).catch(() => null);
            return;
          }

          const gameId = String(state.settings.gameId ?? "").trim();
          if (!gameId) {
            await interaction.reply({ content: "No gameId is set for this event yet.", ephemeral: true }).catch(() => null);
            return;
          }

          if (canSpawnLivePanel(interaction.member)) {
            await startOrReuseLivePanel(interaction, gameId, {
              eventKey: evKey,
              startedAt: state.startedAt,
              timeLimitSeconds: state.settings.timeLimitSeconds,
            });
            return;
          }

          const embed =
            evKey === "deathmatch"
              ? await buildDeathmatchLiveStatsEmbed(gameId, {
                  startedAt: state.startedAt,
                  timeLimitSeconds: state.settings.timeLimitSeconds,
                })
              : await buildKillstreakLiveStatsEmbed(gameId);

          await interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => null);
          return;
        }

        // staff-only controls (for staff/public startgame + all staff panel edits)
        if (!interaction.inGuild?.() || !canUseEventPanel(interaction.member)) {
          await interaction.reply({ content: "Staff-only controls.", ephemeral: true }).catch(() => null);
          return;
        }

        // START GAME (public deathmatch panel, staff only)
        if (customId === "evp:startgame") {
          if (state.status !== "running" || state.panelType !== "public" || state.selectedEventKey !== "deathmatch") {
            await interaction.reply({ content: "Start Game is only for the public Deathmatch panel.", ephemeral: true }).catch(() => null);
            return;
          }

          if (state.startedAt) {
            await interaction.reply({ content: "This game already started.", ephemeral: true }).catch(() => null);
            return;
          }

          const gameId = String(state.settings.gameId ?? "").trim();
          if (!gameId) {
            await interaction.reply({ content: "No gameId is set for this event yet.", ephemeral: true }).catch(() => null);
            return;
          }

          await interaction.deferReply({ ephemeral: true }).catch(() => null);

          const mod = await importDeathmatchModule();
          if (typeof mod?.startDeathmatchGame !== "function") {
            await interaction.editReply({ content: "startDeathmatchGame() not found in deathmatch module." }).catch(() => null);
            return;
          }

          const startRes = await mod.startDeathmatchGame({ gameId });

          if (!startRes?.ok) {
            const reasonMap = {
              already_started: "Game already started.",
              already_starting: "Countdown is already running.",
              no_game: "No active game found.",
              state_missing: "Game state missing.",
            };
            await interaction.editReply({ content: reasonMap[startRes.reason] || "Could not start the game." }).catch(() => null);
            return;
          }

          state.startedAt = nowIso();
          state.startedBy = interaction.user?.id ?? null;
          state.updatedAt = nowIso();
          await saveState(state);

          const guildStates = await getStatesByGuild(interaction.guildId);
          for (const st of guildStates) {
            if (!st || typeof st !== "object") continue;
            if (st.panelType !== "staff") continue;
            if (String(st.announcedMessageId ?? "") !== String(state.messageId)) continue;

            st.startedAt = state.startedAt;
            st.startedBy = state.startedBy;
            st.updatedAt = nowIso();
            await saveState(st);
          }

          await updatePanelMessage(client, state).catch(() => null);
          await interaction.editReply({ content: "Deathmatch started. Countdown sent in-game." }).catch(() => null);
          return;
        }

        if (state.panelType !== "staff") {
          await interaction.reply({ content: "Use the staff setup panel to control this event.", ephemeral: true }).catch(() => null);
          return;
        }

        if (state.status !== "setup") {
          await interaction.reply({ content: "This setup panel is already locked.", ephemeral: true }).catch(() => null);
          return;
        }

        // PICK EVENT
        if (customId.startsWith("evp:pick:")) {
          const key = customId.split(":")[2];
          if (!EVENT_KEYS.includes(key)) {
            await interaction.reply({ content: "Unknown event type.", ephemeral: true }).catch(() => null);
            return;
          }

          state.selectedEventKey = key;
          state.status = "setup";
          state.settings.howToWinOverride = "";
          state.settings.rulesOverride = "";

          normalizeStateForEvent(state);
          state.updatedAt = nowIso();

          await saveState(state);

          await interaction.deferUpdate().catch(() => null);
          await updatePanelMessage(client, state);
          return;
        }

        // EDIT
        if (customId === "evp:edit") {
          if (!state.selectedEventKey) {
            await interaction.reply({ content: "Pick an event first.", ephemeral: true }).catch(() => null);
            return;
          }
          await interaction.showModal(buildEditModal(state)).catch(() => null);
          return;
        }

        // START EVENT
        if (customId === "evp:start") {
          await interaction.deferUpdate().catch(() => null);

          if (!state.selectedEventKey) {
            await interaction.followUp({ content: "Pick an event first.", ephemeral: true }).catch(() => null);
            return;
          }

          if (!state.settings.gameLink?.trim()) {
            const ev = MINI_EVENTS[state.selectedEventKey];
            if (!ev?.canAutoCreate) {
              await interaction
                .followUp({ content: "No game link set. Auto-create is not implemented for this event yet.", ephemeral: true })
                .catch(() => null);
              return;
            }

            try {
              const created = await autoCreateGameForEvent(state.selectedEventKey, {
                region: state.settings.region,
                map: state.settings.map,
                targetNumber: state.settings.targetNumber,
                timeLimitSeconds: state.settings.timeLimitSeconds,
              });

              state.settings.gameId = String(created.gameId ?? "").trim();
              state.settings.gameLink = String(created.gameLink ?? "").trim();
            } catch (e) {
              await interaction.followUp({ content: `Auto-create failed: ${String(e?.message ?? e)}`, ephemeral: true }).catch(() => null);
              return;
            }
          }

          if (!state.settings.gameLink?.trim()) {
            await interaction.followUp({ content: "Still no game link available. Set one in Edit Rules.", ephemeral: true }).catch(() => null);
            return;
          }

          const announceId = await getPanelChannelId(interaction.guildId, "eventannounce");
          if (!announceId) {
            await interaction
              .followUp({ content: "No announcement channel set. Use `-setpanel eventannounce #channel` first.", ephemeral: true })
              .catch(() => null);
            return;
          }

          const announceChannel = await interaction.guild.channels.fetch(announceId).catch(() => null);
          if (!announceChannel?.isTextBased?.()) {
            await interaction
              .followUp({ content: "Announcement channel is invalid. Set it again with `-setpanel eventannounce #channel`.", ephemeral: true })
              .catch(() => null);
            return;
          }

          if (state.selectedEventKey === "deathmatch") {
            state.startedAt = null;
            state.startedBy = null;
          } else {
            const startedAt = nowIso();
            state.startedAt = startedAt;
            state.startedBy = interaction.user?.id ?? null;
          }

          const publicState = cloneForPublic(state, { channelId: announceChannel.id });
          const publicMsg = await announceChannel.send({
            embeds: [buildPublicEmbed(publicState)],
            components: buildComponents(publicState),
          });

          publicState.messageId = publicMsg.id;
          publicState.updatedAt = nowIso();
          await saveState(publicState);

          state.status = "running";
          state.announcedChannelId = announceChannel.id;
          state.announcedMessageId = publicMsg.id;
          state.updatedAt = nowIso();

          await saveState(state);
          await updatePanelMessage(client, state);

          // Wire win callbacks
          await wireWinDetectionForRunningEvent(client, {
            guildId: interaction.guildId,
            publicState,
            announceChannel,
          });

          await interaction.followUp({ content: `Event started and posted in ${announceChannel}.`, ephemeral: true }).catch(() => null);
          return;
        }

        await interaction.reply({ content: "Unknown panel action.", ephemeral: true }).catch(() => null);
        return;
      }

      // --------------------
      // MODALS
      // --------------------
      if (interaction.isModalSubmit()) {
        const { customId } = interaction;

        // CONTROL PANEL MODALS
        if (customId?.startsWith("evc:modal:")) {
          if (!interaction.inGuild?.() || !canUseControlPanel(interaction.member)) {
            await interaction.reply({ content: "Staff-only controls.", ephemeral: true }).catch(() => null);
            return;
          }

          const parts = customId.split(":");
          const action = parts[2];
          const controlMsgId = parts[3];

          const cp = CONTROL_PANELS.get(controlMsgId);
          if (!cp) {
            await interaction.reply({ content: "Control panel expired. Run -controlevent again.", ephemeral: true }).catch(() => null);
            return;
          }

          const bundle = await getActiveEventBundleByGuild(interaction.guildId);
          if (!bundle?.publicState) {
            await interaction.reply({ content: "There is no event playing.", ephemeral: true }).catch(() => null);
            await renderControlPanelMessage(client, cp).catch(() => null);
            return;
          }

          const publicState = bundle.publicState;

          if (action === "chat") {
            const text = String(interaction.fields.getTextInputValue("chatMessage") ?? "").trim();
            if (!text) {
              await interaction.reply({ content: "Message cannot be empty.", ephemeral: true }).catch(() => null);
              return;
            }

            const sendRes = await trySendGameChatForEvent(publicState, text);
            if (!sendRes?.ok) {
              await interaction
                .reply({
                  content: "Couldn't send the in-game message. The gamemode runtime doesn't expose a chat hook yet.",
                  ephemeral: true,
                })
                .catch(() => null);
              return;
            }

            cp.updatedAt = nowIso();
            CONTROL_PANELS.set(cp.messageId, cp);
            await renderControlPanelMessage(client, cp).catch(() => null);

            await interaction.reply({ content: "Message sent in-game.", ephemeral: true }).catch(() => null);
            return;
          }

          if (action === "kick") {
            const playerName = String(interaction.fields.getTextInputValue("playerName") ?? "").trim();
            if (!playerName) {
              await interaction.reply({ content: "Player name is required.", ephemeral: true }).catch(() => null);
              return;
            }

            const kickRes = await tryKickPlayerForEvent(publicState, playerName);
            if (!kickRes?.ok) {
              await interaction
                .reply({
                  content: "Couldn't kick that player. The gamemode runtime doesn't expose a kick/boot hook yet.",
                  ephemeral: true,
                })
                .catch(() => null);
              return;
            }

            cp.updatedAt = nowIso();
            CONTROL_PANELS.set(cp.messageId, cp);
            await renderControlPanelMessage(client, cp).catch(() => null);

            await interaction.reply({ content: `Player kick/boot command sent for "${playerName}".`, ephemeral: true }).catch(() => null);
            return;
          }

          await interaction.reply({ content: "Unknown control modal action.", ephemeral: true }).catch(() => null);
          return;
        }

        // EVENT PANEL MODAL
        if (!customId?.startsWith("evp:modal:")) return;

        const msgId = customId.split(":")[2];
        const state = await getStateByMessageId(msgId);

        if (!state) {
          await interaction.reply({ content: "Panel state missing. Repost with -eventpanel.", ephemeral: true }).catch(() => null);
          return;
        }

        if (!interaction.inGuild?.() || !canUseEventPanel(interaction.member)) {
          await interaction.reply({ content: "Staff-only modal.", ephemeral: true }).catch(() => null);
          return;
        }

        if (state.panelType !== "staff" || state.status !== "setup") {
          await interaction.reply({ content: "This panel can’t be edited right now.", ephemeral: true }).catch(() => null);
          return;
        }

        const gameLink = String(interaction.fields.getTextInputValue("gameLink") ?? "").trim();
        const targetNumber = parseOptionalInt(interaction.fields.getTextInputValue("targetNumber"), { min: 1, max: 100000 });
        const timeLimitSeconds = parseOptionalInt(interaction.fields.getTextInputValue("timeLimitSeconds"), { min: 5, max: 86400 });
        const howToWinOverride = String(interaction.fields.getTextInputValue("howToWinOverride") ?? "").trim();
        const rulesOverride = String(interaction.fields.getTextInputValue("rulesOverride") ?? "").trim();

        if (!isValidHttpUrlMaybeEmpty(gameLink)) {
          await interaction.reply({ content: "Game link must be a valid http(s) URL (or leave it blank).", ephemeral: true }).catch(() => null);
          return;
        }

        state.settings.gameLink = gameLink;
        if (!gameLink) state.settings.gameId = "";

        state.settings.targetNumber = targetNumber;
        state.settings.timeLimitSeconds = timeLimitSeconds;
        state.settings.howToWinOverride = howToWinOverride;
        state.settings.rulesOverride = rulesOverride;

        if (state.selectedEventKey === "killstreak") {
          const txt = howToWinOverride || getHowToWinText(state);
          const parsed = parseFirstInt(txt);
          if (parsed) state.settings.targetNumber = parsed;
        }

        normalizeStateForEvent(state);
        state.updatedAt = nowIso();

        await saveState(state);

        await interaction.reply({ content: "Updated.", ephemeral: true }).catch(() => null);
        await updatePanelMessage(client, state).catch(() => null);
      }
    } catch (e) {
      console.error("[miniEvents] InteractionCreate error:", e);
    }
  });

  console.log("[miniEvents] eventpanel registered");
}