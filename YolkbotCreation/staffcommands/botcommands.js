/* @format */
// staffcommands/botcommands.js
//
// Staff command access + Admin control panel (prefix command).
// Command: -adminpanel
//
// Supports:
// -adminpanel
// @Bot -adminpanel
//
// Exports used elsewhere:
// - canRunStaffCommand(member, commandName)
// - requireStaffCommand(message, prefix, commandName)
//
// Stores config in: staffAccess.json (project root)
//
// UPDATE:
// - Staff access is USER-based (not role-based)
// - BOT_OWNER_IDS env var bypass so the bot owner can always use adminpanel/staff commands

import fs from "node:fs";
import path from "node:path";
import {
  Events,
  EmbedBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} from "discord.js";

console.log("[staff] botcommands.js loaded");

// --------------------
// helpers
// --------------------
const s = (x) => String(x ?? "").trim();

const OWNER_IDS = new Set(
  s(process.env.BOT_OWNER_IDS)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);

function isOwnerId(userId) {
  return OWNER_IDS.has(s(userId));
}

// --------------------
// config store
// --------------------
const CONFIG_PATH = path.resolve(process.cwd(), "staffAccess.json");

function loadCfg() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCfg(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

const cfg = loadCfg();

function getGuildCfg(guildId) {
  const gid = s(guildId);
  if (!cfg[gid]) cfg[gid] = { users: {}, panelAccess: { usersAllow: [] }, legacyRoles: {} };

  // users per command (NEW)
  if (!cfg[gid].users || typeof cfg[gid].users !== "object") cfg[gid].users = {};

  // legacy role-based store (OLD) kept to avoid hard breaking older configs
  // (not shown in UI anymore, but still honored)
  if (!cfg[gid].legacyRoles || typeof cfg[gid].legacyRoles !== "object") cfg[gid].legacyRoles = {};

  // panel access allowlist
  if (!cfg[gid].panelAccess || typeof cfg[gid].panelAccess !== "object") {
    cfg[gid].panelAccess = { usersAllow: [] };
  }
  if (!Array.isArray(cfg[gid].panelAccess.usersAllow)) cfg[gid].panelAccess.usersAllow = [];

  // migrate old structure if it exists (old file used cfg[gid].commands for roles)
  if (cfg[gid].commands && typeof cfg[gid].commands === "object") {
    cfg[gid].legacyRoles = cfg[gid].legacyRoles || {};
    for (const [k, v] of Object.entries(cfg[gid].commands)) {
      if (Array.isArray(v) && !Array.isArray(cfg[gid].legacyRoles[k])) {
        cfg[gid].legacyRoles[k] = v.map(String);
      }
    }
    delete cfg[gid].commands;
    saveCfg(cfg);
  }

  return cfg[gid];
}

// --------------------
// staff command USER access (per command)
// --------------------
function getUsersForCommand(guildId, commandName) {
  const g = getGuildCfg(guildId);
  const key = s(commandName).toLowerCase();
  const arr = g.users[key];
  return Array.isArray(arr) ? arr.map(String) : [];
}

function setUsersForCommand(guildId, commandName, userIds) {
  const g = getGuildCfg(guildId);
  const key = s(commandName).toLowerCase();
  g.users[key] = Array.from(new Set(userIds.map(String)));
  saveCfg(cfg);
}

function addUsersToCommand(guildId, commandName, userIds) {
  const current = new Set(getUsersForCommand(guildId, commandName).map(String));
  for (const id of userIds.map(String)) current.add(id);
  setUsersForCommand(guildId, commandName, Array.from(current));
}

function removeUsersFromCommand(guildId, commandName, userIds) {
  const remove = new Set(userIds.map(String));
  const next = getUsersForCommand(guildId, commandName).filter((id) => !remove.has(String(id)));
  setUsersForCommand(guildId, commandName, next);
}

// --------------------
// legacy ROLE access (still honored, no UI)
// --------------------
function getLegacyRolesForCommand(guildId, commandName) {
  const g = getGuildCfg(guildId);
  const key = s(commandName).toLowerCase();
  const arr = g.legacyRoles?.[key];
  return Array.isArray(arr) ? arr.map(String) : [];
}

// --------------------
// panel access allowlist
// --------------------
function getPanelAllowUsers(guildId) {
  const g = getGuildCfg(guildId);
  return Array.isArray(g.panelAccess.usersAllow) ? g.panelAccess.usersAllow.map(String) : [];
}

function addPanelAllowUsers(guildId, userIds) {
  const g = getGuildCfg(guildId);
  const set = new Set(getPanelAllowUsers(guildId).map(String));
  for (const id of userIds.map(String)) set.add(id);
  g.panelAccess.usersAllow = Array.from(set);
  saveCfg(cfg);
}

function removePanelAllowUsers(guildId, userIds) {
  const g = getGuildCfg(guildId);
  const remove = new Set(userIds.map(String));
  g.panelAccess.usersAllow = getPanelAllowUsers(guildId).filter((id) => !remove.has(String(id)));
  saveCfg(cfg);
}

// --------------------
// embeds
// --------------------
const COLORS = {
  ok: 0x57f287,
  warn: 0xfee75c,
  err: 0xed4245,
  info: 0x5865f2,
};

function makeEmbed({ title, description, color, fields, footer }) {
  const e = new EmbedBuilder().setColor(color ?? COLORS.info).setTimestamp(new Date());
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  if (fields?.length) e.addFields(fields);
  if (footer) e.setFooter({ text: footer });
  return e;
}

function isAdmin(member) {
  return (
    member?.permissions?.has(PermissionsBitField.Flags.Administrator) ||
    member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)
  );
}

function canAccessAdminPanel(member) {
  if (!member?.guild) return false;

  // bot owner always allowed
  if (isOwnerId(member.id)) return true;

  // admins/managers always allowed so they can't lock themselves out
  if (isAdmin(member)) return true;

  const allowed = getPanelAllowUsers(member.guild.id);
  return allowed.includes(String(member.id));
}

// --------------------
// command parsing
// (supports @Bot -cmd as well as -cmd)
// --------------------
function stripLeadingBotMention(text, botId) {
  let t = String(text ?? "").trimStart();
  if (!botId) return t;

  const m1 = `<@${botId}>`;
  const m2 = `<@!${botId}>`;

  if (t.startsWith(m1)) return t.slice(m1.length).trimStart();
  if (t.startsWith(m2)) return t.slice(m2.length).trimStart();
  return t;
}

function parsePrefixed(message, prefix, botId) {
  const content = stripLeadingBotMention(message.content, botId);
  if (!content.startsWith(prefix)) return null;

  const raw = content.slice(prefix.length).trim();
  if (!raw) return null;

  const parts = raw.split(/\s+/);
  const cmd = String(parts.shift() || "").toLowerCase();
  const args = parts;

  return { cmd, args, raw };
}

// --------------------
// exported access helpers (used by other modules)
// --------------------
export function canRunStaffCommand(member, commandName) {
  if (!member || !member.guild) return false;

  // bot owner bypass
  if (isOwnerId(member.id)) return true;

  // admin bypass so you can't lock yourself out
  if (isAdmin(member)) return true;

  // parent permission
  if (canAccessAdminPanel(member)) return true;
  
  // NEW: user allowlist
  const users = getUsersForCommand(member.guild.id, commandName);
  if (users.length && users.includes(String(member.id))) return true;

  // legacy: role allowlist (if you had older config)
  const roles = getLegacyRolesForCommand(member.guild.id, commandName);
  if (roles.length && member.roles?.cache?.some((r) => roles.includes(r.id))) return true;

  return false;
}

export async function requireStaffCommand(message, prefix, commandName) {
  const member = message.member;
  if (canRunStaffCommand(member, commandName)) return true;

  const users = getUsersForCommand(message.guild.id, commandName);
  const userText = users.length ? users.map((id) => `<@${id}>`).join(", ") : "_None configured_";

  await message
    .reply({
      embeds: [
        makeEmbed({
          title: "Permission denied",
          color: COLORS.err,
          description:
            `You can't use \`${prefix}${commandName}\`.\n\n` +
            `**Allowed users:** ${userText}\n` +
            `**Everyone else:** denied`,
        }),
      ],
    })
    .catch(() => {});

  return false;
}

// --------------------
// admin panel UI
// --------------------
const panelState = new Map(); // messageId -> { ownerId, guildId, section, selectedCommand, commands, prefix }

function formatAllowedUsers(guildId) {
  const ids = getPanelAllowUsers(guildId);
  if (!ids.length) return "_None (Admins/Owners only)_";

  const slice = ids.slice(0, 30).map((id) => `<@${id}>`).join(", ");
  return ids.length > 30 ? `${slice}\n…and ${ids.length - 30} more.` : slice;
}

function formatAllowedUsersForCommand(guildId, cmd) {
  const ids = getUsersForCommand(guildId, cmd);
  if (!ids.length) return "_None (Admins/Owners only)_";

  const slice = ids.slice(0, 30).map((id) => `<@${id}>`).join(", ");
  return ids.length > 30 ? `${slice}\n…and ${ids.length - 30} more.` : slice;
}

function renderStaffEmbed(guildId, commands, selectedCommand) {
  const fields = commands.map((cmd) => {
    const userText = formatAllowedUsersForCommand(guildId, cmd);

    return {
      name: cmd,
      value: `**Allowed users:** ${userText}\n**Everyone else:** denied`,
      inline: false,
    };
  });

  return makeEmbed({
    title: "Admin Panel | Staff Command Access",
    color: COLORS.info,
    description:
      "Configure which *users* can run staff commands.\n" +
      "Pick a command, then add/remove users.\n\n" +
      `**Selected:** \`${selectedCommand}\``,
    fields,
    footer: "Stop Configuration to finalize changes",
  });
}

function renderPanelAccessEmbed(guildId) {
  return makeEmbed({
    title: "Admin Panel | Panel Access",
    color: COLORS.info,
    description:
      "Grant/revoke which *users* can open this admin panel.\n" +
      "Admins/Manage Server and Bot Owners always have access.\n\n" +
      "**Allowed users:**\n" +
      formatAllowedUsers(guildId),
    footer: "Stop Configuration to finalize changes",
  });
}

function buildSectionRow(ownerId, section) {
  const sec = new StringSelectMenuBuilder()
    .setCustomId(`ap:section:${ownerId}`)
    .setPlaceholder("Select a panel section")
    .addOptions([
      { label: "Staff Command Access", value: "staff", default: section === "staff" },
      { label: "Panel Access", value: "panel", default: section === "panel" },
    ]);

  return new ActionRowBuilder().addComponents(sec);
}

function buildCommandRow(ownerId, commands, selectedCommand) {
  const cmdSelect = new StringSelectMenuBuilder()
    .setCustomId(`ap:cmd:${ownerId}`)
    .setPlaceholder("Select a command to configure")
    .addOptions(
      commands.map((c) => ({
        label: c,
        value: c,
        default: c === selectedCommand,
      }))
    );

  return new ActionRowBuilder().addComponents(cmdSelect);
}

function buildStaffButtonsRow(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ap:add:${ownerId}`).setLabel("Add Staff User").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ap:remove:${ownerId}`).setLabel("Remove Staff User").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ap:stop:${ownerId}`).setLabel("Stop Configuration").setStyle(ButtonStyle.Secondary)
  );
}

function buildPanelButtonsRow(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ap:stop:${ownerId}`).setLabel("Stop Configuration").setStyle(ButtonStyle.Secondary)
  );
}

function buildStaffUserPickerRow(ownerId, mode /* add|remove */, selectedCommand) {
  const picker = new UserSelectMenuBuilder()
    .setCustomId(`ap:staffuser:${mode}:${selectedCommand}:${ownerId}`)
    .setPlaceholder(mode === "add" ? "Search/select user(s) to ADD" : "Search/select user(s) to REMOVE")
    .setMinValues(1)
    .setMaxValues(5);

  return new ActionRowBuilder().addComponents(picker);
}

function buildPanelUserPickerRows(ownerId) {
  const addUser = new UserSelectMenuBuilder()
    .setCustomId(`ap:panel:add:${ownerId}`)
    .setPlaceholder("Search/select user(s) to ADD panel access")
    .setMinValues(1)
    .setMaxValues(5);

  const removeUser = new UserSelectMenuBuilder()
    .setCustomId(`ap:panel:remove:${ownerId}`)
    .setPlaceholder("Search/select user(s) to REMOVE panel access")
    .setMinValues(1)
    .setMaxValues(5);

  return [new ActionRowBuilder().addComponents(addUser), new ActionRowBuilder().addComponents(removeUser)];
}

function isPanelOwner(interaction, ownerId) {
  return interaction.user?.id === ownerId;
}

function buildPanelView(state, extraRow = null) {
  const rows = [buildSectionRow(state.ownerId, state.section)];

  if (state.section === "panel") {
    rows.push(...buildPanelUserPickerRows(state.ownerId));
    rows.push(buildPanelButtonsRow(state.ownerId));
    return rows;
  }

  // staff section
  rows.push(buildCommandRow(state.ownerId, state.commands, state.selectedCommand));
  rows.push(buildStaffButtonsRow(state.ownerId));
  if (extraRow) rows.push(extraRow);
  return rows;
}

// --------------------
// module entry
// --------------------
export function registerAdminPanel(client, { prefix = "-", commands = ["questpanel"] } = {}) {
  const cmdList = commands.map((c) => String(c).toLowerCase());

  console.log("[adminpanel] registerAdminPanel hooked. prefix =", prefix, "commands =", cmdList);

  // -adminpanel command
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!message.guild) return;
      if (message.author.bot) return;

      const parsed = parsePrefixed(message, prefix, client.user?.id);
      if (!parsed) return;

      if (parsed.cmd !== "adminpanel") return;

      const member = message.member;

      // PUBLIC denial if not allowed
      if (!canAccessAdminPanel(member)) {
        await message.reply({
          embeds: [
            makeEmbed({
              title: "Permission denied",
              color: COLORS.err,
              description:
                "You don't have access to the admin panel.\n\n" +
                "**Allowed:** Admins / Manage Server, Bot Owners, or users explicitly granted access.",
            }),
          ],
        });
        return;
      }

      const selected = cmdList[0] ?? "questpanel";

      const sent = await message.reply({
        embeds: [renderStaffEmbed(message.guild.id, cmdList, selected)],
        components: buildPanelView({
          ownerId: message.author.id,
          guildId: message.guild.id,
          section: "staff",
          selectedCommand: selected,
          commands: cmdList,
          prefix,
        }),
      });

      panelState.set(sent.id, {
        ownerId: message.author.id,
        guildId: message.guild.id,
        section: "staff",
        selectedCommand: selected,
        commands: cmdList,
        prefix,
      });
    } catch (e) {
      console.error("[adminpanel] MessageCreate error:", e);
    }
  });

  // interaction handling (buttons + dropdowns)
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.inGuild()) return;
      if (!interaction.isMessageComponent()) return;

      const cid = interaction.customId || "";
      if (!cid.startsWith("ap:")) return;

      const msgId = interaction.message?.id;
      const state = msgId ? panelState.get(msgId) : null;

      if (!state) {
        await interaction.reply({
          embeds: [
            makeEmbed({
              title: "Panel expired",
              color: COLORS.warn,
              description: `This panel isn't active anymore. Run \`${prefix}adminpanel\` again.`,
            }),
          ],
          ephemeral: true,
        });
        return;
      }

      // PUBLIC denial for anyone without panel access
      const member = interaction.member;
      if (!canAccessAdminPanel(member)) {
        await interaction.reply({
          embeds: [
            makeEmbed({
              title: "Permission denied",
              color: COLORS.err,
              description: "Denied. You don't have access to this panel.",
            }),
          ],
          ephemeral: false,
        });
        return;
      }

      // Keep owner-only editing so other allowed users can't hijack someone else's panel message
      if (!isPanelOwner(interaction, state.ownerId)) {
        await interaction.reply({
          embeds: [
            makeEmbed({
              title: "Not your panel",
              color: COLORS.warn,
              description: "Only the user who opened this panel can change settings.",
            }),
          ],
          ephemeral: true,
        });
        return;
      }

      const isOwner = isOwnerId(interaction.user?.id);
      const isMgr = isAdmin(member);

      // ---- section dropdown ----
      if (interaction.isStringSelectMenu() && cid === `ap:section:${state.ownerId}`) {
        const picked = interaction.values?.[0];
        if (!picked) return;

        state.section = picked === "panel" ? "panel" : "staff";

        if (state.section === "staff" && !state.selectedCommand) {
          state.selectedCommand = state.commands?.[0] ?? "questpanel";
        }

        panelState.set(msgId, state);

        await interaction.update({
          embeds: [
            state.section === "panel"
              ? renderPanelAccessEmbed(state.guildId)
              : renderStaffEmbed(state.guildId, state.commands, state.selectedCommand),
          ],
          components: buildPanelView(state),
        });
        return;
      }

      // ---- staff command dropdown ----
      if (interaction.isStringSelectMenu() && cid === `ap:cmd:${state.ownerId}`) {
        if (state.section !== "staff") return;

        const picked = interaction.values?.[0];
        if (!picked) return;

        state.selectedCommand = picked;
        panelState.set(msgId, state);

        await interaction.update({
          embeds: [renderStaffEmbed(state.guildId, state.commands, state.selectedCommand)],
          components: buildPanelView(state),
        });
        return;
      }

      // ---- user select menus ----
      if (interaction.isUserSelectMenu()) {
        // staff users picker
        if (cid.startsWith("ap:staffuser:")) {
          if (state.section !== "staff") return;

          // Only Admins/Manage Server OR bot owner can change staff access
          if (!isMgr && !isOwner) {
            await interaction.reply({
              embeds: [
                makeEmbed({
                  title: "Permission denied",
                  color: COLORS.err,
                  description: "Only Admins / Manage Server or Bot Owners can modify staff access.",
                }),
              ],
              ephemeral: false,
            });
            return;
          }

          const parts = cid.split(":"); // ap:staffuser:<add|remove>:<command>:<ownerId>
          const mode = parts[2];
          const cmd = parts[3];
          const ownerId = parts[4];
          if (ownerId !== state.ownerId) return;

          const picked = interaction.values ?? [];
          if (!picked.length) return;

          if (mode === "add") addUsersToCommand(state.guildId, cmd, picked);
          else removeUsersFromCommand(state.guildId, cmd, picked);

          await interaction.reply({
            embeds: [
              makeEmbed({
                title: mode === "add" ? "Users added" : "Users removed",
                color: COLORS.ok,
                description:
                  (mode === "add" ? "Granted" : "Revoked") +
                  ` access for \`${state.prefix}${cmd}\`:\n` +
                  picked.map((id) => `• <@${id}>`).join("\n"),
              }),
            ],
            ephemeral: true,
          });

          await interaction.message.edit({
            embeds: [renderStaffEmbed(state.guildId, state.commands, state.selectedCommand)],
            components: buildPanelView(state),
          });

          return;
        }

        // panel access user pickers
        if (state.section !== "panel") return;

        // Only Admins OR bot owner can modify panel access
        if (!isMgr && !isOwner) {
          await interaction.reply({
            embeds: [
              makeEmbed({
                title: "Permission denied",
                color: COLORS.err,
                description: "Only Admins / Manage Server or Bot Owners can modify panel access.",
              }),
            ],
            ephemeral: false,
          });
          return;
        }

        if (cid === `ap:panel:add:${state.ownerId}`) {
          const picked = interaction.values ?? [];
          if (!picked.length) return;

          addPanelAllowUsers(state.guildId, picked);

          await interaction.update({
            embeds: [renderPanelAccessEmbed(state.guildId)],
            components: buildPanelView(state),
          });
          return;
        }

        if (cid === `ap:panel:remove:${state.ownerId}`) {
          const picked = interaction.values ?? [];
          if (!picked.length) return;

          removePanelAllowUsers(state.guildId, picked);

          await interaction.update({
            embeds: [renderPanelAccessEmbed(state.guildId)],
            components: buildPanelView(state),
          });
          return;
        }
      }

      // ---- buttons ----
      if (interaction.isButton()) {
        if (cid === `ap:add:${state.ownerId}`) {
          if (state.section !== "staff") return;

          // Only Admins OR bot owner can change staff access
          if (!isAdmin(member) && !isOwnerId(interaction.user?.id)) {
            await interaction.reply({
              embeds: [
                makeEmbed({
                  title: "Permission denied",
                  color: COLORS.err,
                  description: "Only Admins / Manage Server or Bot Owners can modify staff access.",
                }),
              ],
              ephemeral: true,
            });
            return;
          }

          await interaction.update({
            embeds: [renderStaffEmbed(state.guildId, state.commands, state.selectedCommand)],
            components: buildPanelView(state, buildStaffUserPickerRow(state.ownerId, "add", state.selectedCommand)),
          });
          return;
        }

        if (cid === `ap:remove:${state.ownerId}`) {
          if (state.section !== "staff") return;

          // Only Admins OR bot owner can change staff access
          if (!isAdmin(member) && !isOwnerId(interaction.user?.id)) {
            await interaction.reply({
              embeds: [
                makeEmbed({
                  title: "Permission denied",
                  color: COLORS.err,
                  description: "Only Admins / Manage Server or Bot Owners can modify staff access.",
                }),
              ],
              ephemeral: true,
            });
            return;
          }

          await interaction.update({
            embeds: [renderStaffEmbed(state.guildId, state.commands, state.selectedCommand)],
            components: buildPanelView(state, buildStaffUserPickerRow(state.ownerId, "remove", state.selectedCommand)),
          });
          return;
        }

        if (cid === `ap:stop:${state.ownerId}`) {
          await interaction.update({
            embeds: [
              makeEmbed({
                title: "Changes have been finalized",
                color: COLORS.ok,
                description: "Your admin panel updates are saved.",
              }),
            ],
            components: [],
          });

          panelState.delete(msgId);

          await interaction.message.delete().catch(() => {});
          return;
        }
      }
    } catch (e) {
      console.error("[adminpanel] InteractionCreate error:", e);
      if (interaction.isRepliable()) {
        await interaction
          .reply({
            embeds: [
              makeEmbed({
                title: "Error",
                color: COLORS.err,
                description: "Admin panel interaction failed.",
              }),
            ],
            ephemeral: true,
          })
          .catch(() => {});
      }
    }
  });
}