/** @format */
// miniEvents/controlevent.js

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
} from "discord.js";

import { getActiveLobbyForGuild } from "../src/yolkbotIndex.js";

const PANEL_PREFIX = "controlevent";
const PANEL_SESSIONS = new Map(); // messageId -> { guildId, channelId }

const IDS = {
  refresh: `${PANEL_PREFIX}:refresh`,
  reset: `${PANEL_PREFIX}:reset`,
  resetConfirm: `${PANEL_PREFIX}:reset_confirm`,
  resetCancel: `${PANEL_PREFIX}:reset_cancel`,
  kick: `${PANEL_PREFIX}:kick`,
  chat: `${PANEL_PREFIX}:chat`,
  lockToggle: `${PANEL_PREFIX}:lock_toggle`,
  remake: `${PANEL_PREFIX}:remake`,

  modalKick: `${PANEL_PREFIX}:modal_kick`,
  modalChat: `${PANEL_PREFIX}:modal_chat`,
  modalRemake: `${PANEL_PREFIX}:modal_remake`,
};

function s(v) {
  return String(v ?? "").trim();
}

function hasStaffPerms(memberOrInteraction) {
  const perms =
    memberOrInteraction?.memberPermissions || memberOrInteraction?.member?.permissions;
  if (!perms) return false;
  return perms.has(PermissionsBitField.Flags.ManageGuild) ||
    perms.has(PermissionsBitField.Flags.Administrator);
}

function getActiveEvent(guildId) {
  try {
    return getActiveLobbyForGuild(String(guildId)) || null;
  } catch {
    return null;
  }
}

function getEventMode(active) {
  return s(
    active?.eventType ||
      active?.modeName ||
      active?.mode ||
      active?.type ||
      active?.config?.mode ||
      "Unknown"
  );
}

function getEventRegion(active) {
  return s(active?.region || active?.config?.region || "Unknown");
}

function getEventMap(active) {
  return s(active?.map || active?.config?.map || "Unknown");
}

function getEventMinutes(active) {
  const raw =
    active?.minutes ??
    active?.config?.minutes ??
    active?.config?.durationMinutes ??
    active?.durationMinutes ??
    null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getStartedAtMs(active) {
  const raw =
    active?.runtime?.startedAt ??
    active?.startedAt ??
    active?.state?.startedAt ??
    active?.match?.startedAt ??
    null;

  if (!raw) return null;
  if (typeof raw === "number") return raw;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

function getEndsAtMs(active) {
  const raw =
    active?.runtime?.endsAt ??
    active?.endsAt ??
    active?.state?.endsAt ??
    active?.match?.endsAt ??
    null;

  if (!raw) return null;
  if (typeof raw === "number") return raw;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

function isLobbyLocked(active) {
  return Boolean(
    active?.locked ??
      active?.isLocked ??
      active?.runtime?.locked ??
      active?.config?.locked ??
      false
  );
}

function getPlayerCount(active) {
  const candidates = [
    active?.players,
    active?.roster,
    active?.runtime?.players,
    active?.state?.players,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c.length;
    if (c && typeof c === "object") return Object.keys(c).length;
  }
  return null;
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getRemainingLabel(active) {
  const now = Date.now();
  const endsAt = getEndsAtMs(active);
  if (Number.isFinite(endsAt)) {
    return formatMs(Math.max(0, endsAt - now));
  }

  const startedAt = getStartedAtMs(active);
  const minutes = getEventMinutes(active);
  if (Number.isFinite(startedAt) && Number.isFinite(minutes)) {
    const totalMs = minutes * 60 * 1000;
    const remaining = totalMs - (now - startedAt);
    return formatMs(Math.max(0, remaining));
  }

  return "Not tracked";
}

function buildNoEventEmbed(guildName) {
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("Event Control")
    .setDescription("There is no event currently active.")
    .addFields(
      { name: "Server", value: s(guildName || "Unknown"), inline: true },
      { name: "Status", value: "Idle", inline: true }
    )
    .setTimestamp();
}

function buildPanelEmbed(active, guildName) {
  const playerCount = getPlayerCount(active);
  const locked = isLobbyLocked(active);

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("Event Control")
    .setDescription("Staff event controls for the currently active event.")
    .addFields(
      { name: "Server", value: s(guildName || "Unknown"), inline: true },
      { name: "Status", value: "Active", inline: true },
      { name: "Mode", value: getEventMode(active), inline: true },

      { name: "Region", value: getEventRegion(active), inline: true },
      { name: "Map", value: getEventMap(active), inline: true },
      {
        name: "Lobby",
        value: locked ? "Locked" : "Unlocked",
        inline: true,
      },

      {
        name: "Match Timer",
        value: getRemainingLabel(active),
        inline: true,
      },
      {
        name: "Players",
        value: playerCount == null ? "Unknown" : String(playerCount),
        inline: true,
      },
      {
        name: "Duration",
        value: getEventMinutes(active) ? `${getEventMinutes(active)} min` : "Unknown",
        inline: true,
      }
    )
    .setTimestamp();

  return embed;
}

function buildPanelRows(active) {
  const locked = isLobbyLocked(active);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.refresh)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(IDS.reset)
      .setLabel("Reset Event")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(IDS.remake)
      .setLabel("Remake Event")
      .setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.kick)
      .setLabel("Kick or Boot Player")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(IDS.chat)
      .setLabel("Send In-Game Message")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(IDS.lockToggle)
      .setLabel(locked ? "Unlock Lobby" : "Lock Lobby")
      .setStyle(locked ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  return [row1, row2];
}

function buildDisabledRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.refresh).setLabel("Refresh").setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(IDS.reset).setLabel("Reset Event").setStyle(ButtonStyle.Danger).setDisabled(true),
    new ButtonBuilder().setCustomId(IDS.remake).setLabel("Remake Event").setStyle(ButtonStyle.Primary).setDisabled(true)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.kick).setLabel("Kick or Boot Player").setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(IDS.chat).setLabel("Send In-Game Message").setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(IDS.lockToggle).setLabel("Lock Lobby").setStyle(ButtonStyle.Secondary).setDisabled(true)
  );

  return [row1, row2];
}

function resolveController(active) {
  const control = active?.control || active?.controller || {};
  const bot = active?.bot || active?.yolkbot || control?.bot || null;
  const game = active?.game || bot?.game || null;

  return {
    bot,
    game,

    async sendChat(text) {
      if (typeof control.sendChat === "function") return control.sendChat(text);
      if (typeof control.chat === "function") return control.chat(text);

      if (typeof game?.sendChat === "function") return game.sendChat(text);
      if (typeof bot?.sendChat === "function") return bot.sendChat(text);

      throw new Error("No in-game chat method is available on the active event.");
    },

    async setLocked(locked) {
      if (typeof control.setLocked === "function") return control.setLocked(Boolean(locked));
      if (locked && typeof control.lockLobby === "function") return control.lockLobby();
      if (!locked && typeof control.unlockLobby === "function") return control.unlockLobby();

      if (typeof game?.setLocked === "function") return game.setLocked(Boolean(locked));
      if (typeof game?.lock === "function" && locked) return game.lock();
      if (typeof game?.unlock === "function" && !locked) return game.unlock();

      // fallback no-op if your project tracks lock in memory and applies elsewhere
      active.isLocked = Boolean(locked);
      active.locked = Boolean(locked);
      if (active.config && typeof active.config === "object") active.config.locked = Boolean(locked);

      return;
    },

    async kickPlayer(playerName, reason) {
      if (typeof control.kickPlayer === "function") return control.kickPlayer(playerName, reason);
      if (typeof control.bootPlayer === "function") return control.bootPlayer(playerName, reason);
      if (typeof control.kick === "function") return control.kick(playerName, reason);

      if (typeof game?.kickPlayer === "function") return game.kickPlayer(playerName, reason);
      if (typeof game?.kick === "function") return game.kick(playerName);

      throw new Error("No kick/boot method is available on the active event.");
    },

    async resetGame() {
      // Best effort. Your event modules can expose stronger hooks on active.control.
      if (typeof control.resetGame === "function") return control.resetGame();
      if (typeof control.resetEvent === "function") return control.resetEvent();
      if (typeof control.reset === "function") return control.reset();

      // Re-apply settings if that is how your modes reset state.
      if (typeof control.applyServerSettings === "function") return control.applyServerSettings();
      if (typeof control.reapplySettings === "function") return control.reapplySettings();
      if (typeof game?.applySettings === "function") return game.applySettings(active?.config || {});

      // Nothing callable, but runtime reset still happens outside this function.
      return;
    },

    async remakeEvent(overrides) {
      if (typeof control.remakeEvent === "function") return control.remakeEvent(overrides);
      if (typeof control.remake === "function") return control.remake(overrides);
      if (typeof active?.remakeEvent === "function") return active.remakeEvent(overrides);
      throw new Error("Remake is not wired yet on this event. Add active.control.remakeEvent().");
    },
  };
}

function clearObject(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const k of Object.keys(obj)) delete obj[k];
}

function resetKnownStatContainers(active) {
  // Reset common places your modes tend to store runtime stats.
  if (!active || typeof active !== "object") return;

  // direct common containers
  if (active.stats && typeof active.stats === "object") clearObject(active.stats);
  if (active.playerStats && typeof active.playerStats === "object") clearObject(active.playerStats);
  if (active.scoreboard && typeof active.scoreboard === "object") clearObject(active.scoreboard);

  // runtime/state nested containers
  for (const root of [active.runtime, active.state, active.match]) {
    if (!root || typeof root !== "object") continue;
    if (root.kills && typeof root.kills === "object") clearObject(root.kills);
    if (root.deaths && typeof root.deaths === "object") clearObject(root.deaths);
    if (root.kdr && typeof root.kdr === "object") clearObject(root.kdr);
    if (root.playerStats && typeof root.playerStats === "object") clearObject(root.playerStats);
    if (root.scoreboard && typeof root.scoreboard === "object") clearObject(root.scoreboard);

    // numeric counters fallback
    if (typeof root.killCount === "number") root.killCount = 0;
    if (typeof root.deathCount === "number") root.deathCount = 0;
  }
}

function restartTimer(active) {
  const minutes = getEventMinutes(active);
  const now = Date.now();

  if (!active.runtime || typeof active.runtime !== "object") active.runtime = {};
  active.runtime.startedAt = now;

  if (minutes) {
    active.runtime.endsAt = now + minutes * 60 * 1000;
  } else {
    delete active.runtime.endsAt;
  }

  // mirror common locations if your code reads from these
  active.startedAt = now;
  if (minutes) active.endsAt = now + minutes * 60 * 1000;
}

async function performReset(active, client, actorTag) {
  const ctrl = resolveController(active);

  resetKnownStatContainers(active);
  restartTimer(active);

  // Let mode-specific code clear hidden Maps/Symbols/etc.
  client.emit("miniEventReset", {
    guildId: s(active.guildId),
    gameId: s(active.gameId),
    actor: actorTag,
    mode: getEventMode(active),
    at: Date.now(),
  });

  process.emit("miniEventReset", {
    guildId: s(active.guildId),
    gameId: s(active.gameId),
    actor: actorTag,
    mode: getEventMode(active),
    at: Date.now(),
  });

  await ctrl.resetGame();

  // Optional staff notice in-game if chat is available.
  try {
    await ctrl.sendChat("Event reset by staff. Match timer and event tracking restarted.");
  } catch {
    // No chat method wired, ignore.
  }
}

function buildResetConfirmRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.resetConfirm)
      .setLabel("Confirm Reset")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(IDS.resetCancel)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function openKickModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(IDS.modalKick)
    .setTitle("Kick or Boot Player");

  const playerInput = new TextInputBuilder()
    .setCustomId("player")
    .setLabel("Player name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32)
    .setPlaceholder("Exact in-game name");

  const reasonInput = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Reason (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100)
    .setPlaceholder("Policy or event reason");

  modal.addComponents(
    new ActionRowBuilder().addComponents(playerInput),
    new ActionRowBuilder().addComponents(reasonInput)
  );

  await interaction.showModal(modal);
}

async function openChatModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(IDS.modalChat)
    .setTitle("Send In-Game Message");

  const msgInput = new TextInputBuilder()
    .setCustomId("message")
    .setLabel("Message")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(180)
    .setPlaceholder("Message to send to the in-game chat");

  modal.addComponents(new ActionRowBuilder().addComponents(msgInput));
  await interaction.showModal(modal);
}

async function openRemakeModal(interaction, active) {
  const modal = new ModalBuilder()
    .setCustomId(IDS.modalRemake)
    .setTitle("Remake Event");

  const regionInput = new TextInputBuilder()
    .setCustomId("region")
    .setLabel("Region")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(32)
    .setValue(getEventRegion(active))
    .setPlaceholder("uscentral / germany");

  const mapInput = new TextInputBuilder()
    .setCustomId("map")
    .setLabel("Map")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(32)
    .setValue(getEventMap(active))
    .setPlaceholder("cluckgrounds / castle / blue");

  const minutesInput = new TextInputBuilder()
    .setCustomId("minutes")
    .setLabel("Minutes (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(4)
    .setValue(getEventMinutes(active) ? String(getEventMinutes(active)) : "")
    .setPlaceholder("Example: 10");

  modal.addComponents(
    new ActionRowBuilder().addComponents(regionInput),
    new ActionRowBuilder().addComponents(mapInput),
    new ActionRowBuilder().addComponents(minutesInput)
  );

  await interaction.showModal(modal);
}

async function refreshPanelMessage(interactionOrMessage) {
  const msg = interactionOrMessage?.message || interactionOrMessage;
  if (!msg?.guildId) return;

  const guild = msg.guild;
  const active = getActiveEvent(msg.guildId);

  if (!active) {
    await msg.edit({
      embeds: [buildNoEventEmbed(guild?.name)],
      components: buildDisabledRows(),
    }).catch(() => {});
    return;
  }

  await msg.edit({
    embeds: [buildPanelEmbed(active, guild?.name)],
    components: buildPanelRows(active),
  }).catch(() => {});
}

export function registerControlEventPanel(client, opts = {}) {
  const PREFIX = s(opts.prefix || "-");
  const commandName = "controlevent";

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!message.guild || message.author.bot) return;
      const content = s(message.content);
      if (!content.toLowerCase().startsWith(`${PREFIX}${commandName}`)) return;

      if (!hasStaffPerms(message)) {
        await message.reply({
          content: "You do not have permission to use this staff event control panel.",
        });
        return;
      }

      const active = getActiveEvent(message.guildId);
      if (!active) {
        await message.reply({
          embeds: [buildNoEventEmbed(message.guild?.name)],
        });
        return;
      }

      const sent = await message.reply({
        embeds: [buildPanelEmbed(active, message.guild?.name)],
        components: buildPanelRows(active),
      });

      PANEL_SESSIONS.set(sent.id, {
        guildId: message.guildId,
        channelId: message.channelId,
      });
    } catch (err) {
      console.error("[controlevent] command error:", err);
      await message.reply({
        content: "Failed to open the event control panel.",
      }).catch(() => {});
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // Buttons
      if (interaction.isButton() && s(interaction.customId).startsWith(`${PANEL_PREFIX}:`)) {
        if (!interaction.guildId) return;
        if (!hasStaffPerms(interaction)) {
          await interaction.reply({
            content: "You do not have permission to use this staff event control panel.",
            ephemeral: true,
          });
          return;
        }

        const panelSession = PANEL_SESSIONS.get(interaction.message.id);
        const guildId = panelSession?.guildId || interaction.guildId;
        const active = getActiveEvent(guildId);

        if (!active) {
          await interaction.reply({
            content: "There is no event currently active.",
            ephemeral: true,
          });
          await refreshPanelMessage(interaction);
          return;
        }

        const ctrl = resolveController(active);

        switch (interaction.customId) {
          case IDS.refresh: {
            await interaction.deferUpdate();
            await refreshPanelMessage(interaction);
            return;
          }

          case IDS.reset: {
            await interaction.reply({
              content:
                "Reset this event now? This will restart the match timer and clear tracked event stats.",
              components: [buildResetConfirmRow()],
              ephemeral: true,
            });
            return;
          }

          case IDS.resetConfirm: {
            await interaction.deferUpdate();
            await performReset(active, client, s(interaction.user?.tag || interaction.user?.id));
            await refreshPanelMessage(interaction.message);
            return;
          }

          case IDS.resetCancel: {
            await interaction.update({
              content: "Reset cancelled.",
              components: [],
            });
            return;
          }

          case IDS.kick: {
            await openKickModal(interaction);
            return;
          }

          case IDS.chat: {
            await openChatModal(interaction);
            return;
          }

          case IDS.lockToggle: {
            const nextLocked = !isLobbyLocked(active);
            await ctrl.setLocked(nextLocked);

            active.isLocked = nextLocked;
            active.locked = nextLocked;
            if (active.config && typeof active.config === "object") {
              active.config.locked = nextLocked;
            }

            // Optional in-game notice
            try {
              await ctrl.sendChat(nextLocked ? "Lobby locked by staff." : "Lobby unlocked by staff.");
            } catch {
              // ignore if no chat method available
            }

            await interaction.deferUpdate();
            await refreshPanelMessage(interaction);
            return;
          }

          case IDS.remake: {
            await openRemakeModal(interaction, active);
            return;
          }

          default:
            return;
        }
      }

      // Modals
      if (interaction.isModalSubmit() && s(interaction.customId).startsWith(`${PANEL_PREFIX}:`)) {
        if (!interaction.guildId) return;

        if (!hasStaffPerms(interaction)) {
          await interaction.reply({
            content: "You do not have permission to use this staff event control panel.",
            ephemeral: true,
          });
          return;
        }

        const active = getActiveEvent(interaction.guildId);
        if (!active) {
          await interaction.reply({
            content: "There is no event currently active.",
            ephemeral: true,
          });
          return;
        }

        const ctrl = resolveController(active);

        if (interaction.customId === IDS.modalKick) {
          const player = s(interaction.fields.getTextInputValue("player"));
          const reason = s(interaction.fields.getTextInputValue("reason"));

          if (!player) {
            await interaction.reply({
              content: "Player name is required.",
              ephemeral: true,
            });
            return;
          }

          await ctrl.kickPlayer(player, reason || undefined);

          await interaction.reply({
            content: `Kick/boot request sent for "${player}".`,
            ephemeral: true,
          });

          // Optional notice to lobby
          try {
            if (reason) {
              await ctrl.sendChat(`Staff removed ${player}. Reason: ${reason}`);
            } else {
              await ctrl.sendChat(`Staff removed ${player}.`);
            }
          } catch {
            // ignore
          }

          return;
        }

        if (interaction.customId === IDS.modalChat) {
          const text = s(interaction.fields.getTextInputValue("message"));
          if (!text) {
            await interaction.reply({
              content: "Message cannot be empty.",
              ephemeral: true,
            });
            return;
          }

          await ctrl.sendChat(text);

          await interaction.reply({
            content: "Message sent to in-game chat.",
            ephemeral: true,
          });
          return;
        }

        if (interaction.customId === IDS.modalRemake) {
          const region = s(interaction.fields.getTextInputValue("region")) || getEventRegion(active);
          const map = s(interaction.fields.getTextInputValue("map")) || getEventMap(active);
          const minutesRaw = s(interaction.fields.getTextInputValue("minutes"));
          const minutesNum = minutesRaw ? Number(minutesRaw) : getEventMinutes(active);

          if (minutesRaw && (!Number.isFinite(minutesNum) || minutesNum <= 0)) {
            await interaction.reply({
              content: "Minutes must be a valid number.",
              ephemeral: true,
            });
            return;
          }

          const overrides = {
            region,
            map,
            minutes: minutesNum || undefined,
            // preserves mode/type implicitly from active event
          };

          await interaction.deferReply({ ephemeral: true });

          await ctrl.remakeEvent(overrides);

          await interaction.editReply({
            content: "Remake request sent. The event should be recreated using the updated settings.",
          });

          // Refresh the control panel message if this modal came from a button on one
          await refreshPanelMessage(interaction.message || interaction);
          return;
        }
      }
    } catch (err) {
      console.error("[controlevent] interaction error:", err);

      if (interaction.isRepliable()) {
        const msg =
          err?.message && typeof err.message === "string"
            ? `Control action failed: ${err.message}`
            : "Control action failed.";

        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
        } else {
          await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        }
      }
    }
  });
}