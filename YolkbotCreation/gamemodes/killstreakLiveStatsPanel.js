/** @format */
// gamemodes/killstreakLiveStatsPanel.js

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";

import { getKillstreakSnapshot } from "./killStreaks.js";

// guildId -> { gameId, channelId, messageId, timer, startedAt }
const LIVE_PANELS = new Map();

const s = (x) => String(x ?? "").trim();

export function buildKillstreakLiveStatsButton(gameId) {
  return new ButtonBuilder()
    .setCustomId(`ks_live_stats:${s(gameId)}`)
    .setEmoji("📃") // page with curl
    .setLabel("Live Stats")
    .setStyle(ButtonStyle.Secondary);
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "0s";
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  if (m <= 0) return `${r}s`;
  return `${m}m ${r}s`;
}

function buildStatsEmbed(gameId) {
  const snap = getKillstreakSnapshot(gameId, { limit: 10 });

  const lines =
    snap.leaderboard.length > 0
      ? snap.leaderboard.map((p, i) => {
          const rank = String(i + 1).padStart(2, "0");
          return `**${rank}. ${p.name}**  | streak: **${p.streak}** | best: ${p.best} | kills: ${p.kills}`;
        })
      : ["No kills yet. Everyone is being shockingly peaceful."];

  const startedAgo = snap.startedAt ? formatDuration(Date.now() - snap.startedAt) : "unknown";

  return new EmbedBuilder()
    .setTitle("Killstreak Live Stats")
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "Game", value: `\`${s(gameId) || "unknown"}\``, inline: true },
      { name: "Started", value: startedAgo, inline: true },
      { name: "Tracked", value: String(snap.totalTracked || 0), inline: true }
    )
    .setFooter({ text: "Updates every 5s while the panel is running." });
}

async function startOrReusePanel(interaction, gameId) {
  const guildId = s(interaction.guildId);
  const channelId = s(interaction.channelId);

  if (!guildId || !channelId) {
    await interaction.reply({ content: "This only works inside a server channel.", ephemeral: true });
    return;
  }

  const existing = LIVE_PANELS.get(guildId);
  if (existing && existing.gameId === s(gameId)) {
    const url = `https://discord.com/channels/${guildId}/${existing.channelId}/${existing.messageId}`;
    await interaction.reply({ content: `Live stats panel already running:\n${url}`, ephemeral: true });
    return;
  }

  // Basic anti-abuse: only allow staff to spawn an auto-updating panel
  const mePerms = interaction.memberPermissions;
  const canSpawn =
    mePerms?.has?.(PermissionsBitField.Flags.ManageGuild) ||
    mePerms?.has?.(PermissionsBitField.Flags.ManageMessages) ||
    mePerms?.has?.(PermissionsBitField.Flags.Administrator);

  if (!canSpawn) {
    // Non-staff gets an ephemeral snapshot (no interval spam)
    await interaction.reply({ embeds: [buildStatsEmbed(gameId)], ephemeral: true });
    return;
  }

  // Kill old timer if any
  if (existing?.timer) clearInterval(existing.timer);

  // Post panel message in the same channel
  const msg = await interaction.channel.send({
    embeds: [buildStatsEmbed(gameId)],
  });

  const timer = setInterval(async () => {
    try {
      await msg.edit({ embeds: [buildStatsEmbed(gameId)] });
    } catch {
      // message deleted or permissions changed: stop updating
      clearInterval(timer);
    }
  }, 5000);

  LIVE_PANELS.set(guildId, {
    gameId: s(gameId),
    channelId,
    messageId: msg.id,
    timer,
    startedAt: Date.now(),
  });

  const url = `https://discord.com/channels/${guildId}/${channelId}/${msg.id}`;
  await interaction.reply({ content: `Live stats panel created:\n${url}`, ephemeral: true });
}

export async function handleKillstreakLiveStatsButton(interaction) {
  const id = s(interaction.customId);
  if (!id.startsWith("ks_live_stats:")) return false;

  const gameId = id.split(":")[1] || "";
  await startOrReusePanel(interaction, gameId);
  return true;
}