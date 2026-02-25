/** @format */
// miniEvents/deathmatchLiveStats.js

import { EmbedBuilder } from "discord.js";

const s = (x) => String(x ?? "").trim();
const LIVE_STATS_VERSION = "dmLiveStats:v2"; // <-- fingerprint

function fmtKdr(kills, deaths) {
  const k = Number(kills || 0);
  const d = Number(deaths || 0);
  if (d <= 0) return String(k);
  return (k / d).toFixed(2);
}

async function importDeathmatchModule() {
  // Try both casings so this doesn’t randomly die on Linux vs Windows.
  try {
    return await import("../gamemodes/deathMatch.js");
  } catch {}
  try {
    return await import("../gamemodes/deathMatch.js");
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

function toUnixSeconds(ms) {
  const n = Number(ms || 0);
  if (!n) return 0;
  return Math.floor(n / 1000);
}

export async function buildDeathmatchLiveStatsEmbed(gameId) {
  const gid = String(gameId ?? "").trim();
  const snap = await tryGetDeathmatchSnapshot(gid, { limit: 10 });

  const embed = new EmbedBuilder()
    .setTitle("Deathmatch Live Stats")
    .setFooter({ text: LIVE_STATS_VERSION });

  if (!snap) {
    embed.addFields(
      { name: "Time Remaining", value: "—", inline: true },
      { name: "Players", value: "—", inline: false },
      { name: "Leaderboard", value: "—", inline: false }
    );
    return embed;
  }

  const now = Date.now();
  const endsAt = Number(snap.endsAt || 0);
  const startedAt = Number(snap.startedAt || 0);

  let timeVal = "—";
  if (endsAt > 0) {
    const unix = toUnixSeconds(endsAt);
    const leftSec = Math.max(0, Math.round((endsAt - now) / 1000));

    // Discord “live” timer (client-updated) + exact end time.
    // This is the white/grey pill you’re describing.
    if (leftSec <= 0) {
    } else {
      timeVal = `**Remaining:** <t:${unix}:R>\n**Ends at:** <t:${unix}:T>`;
    }
  } else if (startedAt > 0) {
    timeVal = "—";
  }

  const playersVal = snap.players?.length
    ? snap.players.map((p) => `• ${p}`).join("\n")
    : "—";

  const lbVal =
    snap.leaderboard?.length > 0
      ? snap.leaderboard
          .map((p, i) => {
            const rank = String(i + 1).padStart(2, "0");
            const name = s(p?.name);
            const kills = Number(p?.kills || 0);
            const deaths = Number(p?.deaths || 0);
            const kdr = s(p?.kdr) || fmtKdr(kills, deaths);
            return `**${rank}. ${name}** | K:${kills} D:${deaths} KDR:${kdr}`;
          })
          .join("\n")
      : "—";

  embed.addFields(
    { name: "Time Remaining", value: timeVal, inline: true },
    { name: "Players", value: playersVal, inline: false },
    { name: "Leaderboard", value: lbVal, inline: false }
  );

  return embed;
}

export async function startOrReuseDeathmatchLivePanel(
  interaction,
  gameId,
  { livePanels, key, intervalMs = 5000 } = {}
) {
  const guildId = String(interaction.guildId ?? "").trim();
  const channelId = String(interaction.channelId ?? "").trim();
  const gid = String(gameId ?? "").trim();
  if (!guildId || !channelId || !gid) return;

  const k = key || `${guildId}:deathmatch`;
  const existing = livePanels?.get?.(k);

  if (existing?.gameId === gid) {
    const url = `https://discord.com/channels/${guildId}/${existing.channelId}/${existing.messageId}`;
    await interaction.reply({
      content: `Live stats panel already running:\n${url}`,
      ephemeral: true,
    }).catch(() => null);
    return;
  }

  if (existing?.timer) {
    try { clearInterval(existing.timer); } catch {}
  }

  const embed = await buildDeathmatchLiveStatsEmbed(gid);
  const msg = await interaction.channel?.send?.({ embeds: [embed] }).catch(() => null);

  if (!msg) {
    await interaction.reply({
      content: "Couldn't create a live panel in this channel.",
      ephemeral: true,
    }).catch(() => null);
    return;
  }

  // Don’t kill the panel forever on one transient edit failure.
  let failCount = 0;

  const timer = setInterval(async () => {
    try {
      const e = await buildDeathmatchLiveStatsEmbed(gid);
      await msg.edit({ embeds: [e] });
      failCount = 0;
    } catch {
      failCount += 1;
      if (failCount >= 5) {
        try { clearInterval(timer); } catch {}
      }
    }
  }, Math.max(2000, Number(intervalMs) || 5000));

  livePanels?.set?.(k, {
    gameId: gid,
    channelId,
    messageId: msg.id,
    timer,
  });

  const url = `https://discord.com/channels/${guildId}/${channelId}/${msg.id}`;
  await interaction.reply({ content: `Live stats panel created:\n${url}`, ephemeral: true }).catch(() => null);
}