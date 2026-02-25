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
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
} from "discord.js";

console.log("[staff] botcommands.js loaded");

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
  const gid = String(guildId);
  if (!cfg[gid]) cfg[gid] = { commands: {}, panelAccess: { usersAllow: [] } };

  if (!cfg[gid].commands || typeof cfg[gid].commands !== "object") cfg[gid].commands = {};

  if (!cfg[gid].panelAccess || typeof cfg[gid].panelAccess !== "object") {
    cfg[gid].panelAccess = { usersAllow: [] };
  }
  if (!Array.isArray(cfg[gid].panelAccess.usersAllow)) cfg[gid].panelAccess.usersAllow = [];

  return cfg[gid];
}

// --------------------
// staff command role access (per command)
// --------------------
function getRolesForCommand(guildId, commandName) {
  const g = getGuildCfg(guildId);
  const key = String(commandName).toLowerCase();
  const arr = g.commands[key];
  return Array.isArray(arr) ? arr : [];
}

function setRolesForCommand(guildId, commandName, roleIds) {
  const g = getGuildCfg(guildId);
  const key = String(commandName).toLowerCase();
  g.commands[key] = Array.from(new Set(roleIds.map(String)));
  saveCfg(cfg);
}

function addRoleToCommand(guildId, commandName, roleId) {
  const roles = getRolesForCommand(guildId, commandName);
  const rid = String(roleId);
  if (!roles.includes(rid)) roles.push(rid);
  setRolesForCommand(guildId, commandName, roles);
}

function removeRoleFromCommand(guildId, commandName, roleId) {
  const rid = String(roleId);
  const roles = getRolesForCommand(guildId, commandName).filter((id) => id !== rid);
  setRolesForCommand(guildId, commandName, roles);
}

// --------------------
// panel access allowlist
// --------------------
function getPanelAllowUsers(guildId) {
  const g = getGuildCfg(guildId);
  return Array.isArray(g.panelAccess.usersAllow) ? g.panelAccess.usersAllow : [];
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
  g.panelAccess.usersAllow = getPanelAllowUsers(guildId).map(String).filter((id) => !remove.has(id));
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
  if (isAdmin(member)) return true; // hard bypass so admins can't lock themselves out
  const allowed = getPanelAllowUsers(member.guild.id);
  return allowed.includes(String(member.id));
}

// --------------------
// command parsing
// (supports @Bot -cmd as well as -cmd)
// --------------------
function stripLeadingBotMention(text, botId) {
  let s = String(text ?? "").trimStart();
  if (!botId) return s;

  const m1 = `<@${botId}>`;
  const m2 = `<@!${botId}>`;

  if (s.startsWith(m1)) return s.slice(m1.length).trimStart();
  if (s.startsWith(m2)) return s.slice(m2.length).trimStart();
  return s;
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
  if (isAdmin(member)) return true; // admin bypass so you can't lock yourself out

  const roles = getRolesForCommand(member.guild.id, commandName);
  if (!roles.length) return false;

  return member.roles.cache.some((r) => roles.includes(r.id));
}

export async function requireStaffCommand(message, prefix, commandName) {
  const member = message.member;
  if (canRunStaffCommand(member, commandName)) return true;

  const roles = getRolesForCommand(message.guild.id, commandName);
  const roleText = roles.length ? roles.map((id) => `<@&${id}>`).join(" ") : "_None configured_";

  await message
    .reply({
      embeds: [
        makeEmbed({
          title: "Permission denied",
          color: COLORS.err,
          description:
            `You can't use \`${prefix}${commandName}\`.\n\n` +
            `**Allowed roles:** ${roleText}\n` +
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
  if (!ids.length) return "_None (Admins only)_";

  const slice = ids.slice(0, 30).map((id) => `<@${id}>`).join(", ");
  return ids.length > 30 ? `${slice}\n…and ${ids.length - 30} more.` : slice;
}

function renderStaffEmbed(guildId, commands, selectedCommand) {
  const fields = commands.map((cmd) => {
    const roles = getRolesForCommand(guildId, cmd);
    const roleText = roles.length ? roles.map((id) => `<@&${id}>`).join(" ") : "_None (Admins only)_";
    return {
      name: cmd,
      value: `**Allowed:** ${roleText}\n**Everyone else:** denied`,
      inline: false,
    };
  });

  return makeEmbed({
    title: "Admin Panel | Staff Command Access",
    color: COLORS.info,
    description:
      "Configure which roles can run staff commands.\n" +
      "Pick a command, then add/remove roles.\n\n" +
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
      "Admins/Manage Server always have access.\n\n" +
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
    new ButtonBuilder().setCustomId(`ap:add:${ownerId}`).setLabel("Add Staff Role").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ap:remove:${ownerId}`).setLabel("Remove Staff Role").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ap:stop:${ownerId}`).setLabel("Stop Configuration").setStyle(ButtonStyle.Secondary)
  );
}

function buildPanelButtonsRow(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ap:stop:${ownerId}`).setLabel("Stop Configuration").setStyle(ButtonStyle.Secondary)
  );
}

function buildRolePickerRow(ownerId, mode /* add|remove */, selectedCommand) {
  const rolePicker = new RoleSelectMenuBuilder()
    .setCustomId(`ap:role:${mode}:${selectedCommand}:${ownerId}`)
    .setPlaceholder(mode === "add" ? "Pick a role to ADD" : "Pick a role to REMOVE")
    .setMinValues(1)
    .setMaxValues(1);

  return new ActionRowBuilder().addComponents(rolePicker);
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
                "**Allowed:** Admins / Manage Server, or users explicitly granted access.",
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

      // PUBLIC denial for anyone without panel access (your request, even though it's noisy)
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

      // Keep owner-only editing so random allowed users can't hijack someone else's panel message
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

      // ---- section dropdown ----
      if (interaction.isStringSelectMenu() && cid === `ap:section:${state.ownerId}`) {
        const picked = interaction.values?.[0];
        if (!picked) return;

        state.section = picked === "panel" ? "panel" : "staff";

        // Ensure we have a command selected when switching back
        if (state.section === "staff" && !state.selectedCommand) {
          state.selectedCommand = state.commands?.[0] ?? "questpanel";
        }

        panelState.set(msgId, state);

        await interaction.update({
          embeds: [state.section === "panel" ? renderPanelAccessEmbed(state.guildId) : renderStaffEmbed(state.guildId, state.commands, state.selectedCommand)],
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

      // ---- panel access user pickers (admins only) ----
      if (interaction.isUserSelectMenu()) {
        if (state.section !== "panel") return;

        // Only admins can grant/revoke panel access
        if (!isAdmin(member)) {
          await interaction.reply({
            embeds: [
              makeEmbed({
                title: "Permission denied",
                color: COLORS.err,
                description: "Only Admins / Manage Server can modify panel access.",
              }),
            ],
            ephemeral: false, // public, since you asked for public denial
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

          await interaction.update({
            embeds: [renderStaffEmbed(state.guildId, state.commands, state.selectedCommand)],
            components: buildPanelView(state, buildRolePickerRow(state.ownerId, "add", state.selectedCommand)),
          });
          return;
        }

        if (cid === `ap:remove:${state.ownerId}`) {
          if (state.section !== "staff") return;

          await interaction.update({
            embeds: [renderStaffEmbed(state.guildId, state.commands, state.selectedCommand)],
            components: buildPanelView(state, buildRolePickerRow(state.ownerId, "remove", state.selectedCommand)),
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

          // If you REALLY want it to disappear, try deleting it (may fail due to perms)
          await interaction.message.delete().catch(() => {});
          return;
        }
      }

      // ---- role select ----
      if (interaction.isRoleSelectMenu()) {
        if (state.section !== "staff") return;

        // ap:role:<add|remove>:<command>:<ownerId>
        const parts = cid.split(":");
        const mode = parts[2];
        const cmd = parts[3];
        const ownerId = parts[4];

        if (ownerId !== state.ownerId) return;

        const roleId = interaction.values?.[0];
        if (!roleId) return;

        if (mode === "add") {
          addRoleToCommand(state.guildId, cmd, roleId);
          await interaction.reply({
            embeds: [
              makeEmbed({
                title: "Role added",
                color: COLORS.ok,
                description: `Added <@&${roleId}> to \`${state.prefix}${cmd}\` access.`,
              }),
            ],
            ephemeral: true,
          });
        } else {
          const before = getRolesForCommand(state.guildId, cmd);
          removeRoleFromCommand(state.guildId, cmd, roleId);

          const removed = before.includes(roleId);
          await interaction.reply({
            embeds: [
              makeEmbed({
                title: removed ? "Role removed" : "Nothing to remove",
                color: removed ? COLORS.ok : COLORS.warn,
                description: removed
                  ? `Removed <@&${roleId}> from \`${state.prefix}${cmd}\` access.`
                  : `<@&${roleId}> was not configured for \`${state.prefix}${cmd}\`.`,
              }),
            ],
            ephemeral: true,
          });
        }

        // Refresh panel (hide picker row)
        await interaction.message.edit({
          embeds: [renderStaffEmbed(state.guildId, state.commands, state.selectedCommand)],
          components: buildPanelView(state),
        });

        return;
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
