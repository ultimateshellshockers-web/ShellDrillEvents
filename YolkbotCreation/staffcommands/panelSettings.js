/** @format */
// staffcommands/panelSettings.js

import { ChannelType, EmbedBuilder, Events } from "discord.js";
import { query } from "../src/db.js";
import { requireStaffCommand } from "./botcommands.js";

const PANELS = {
  // where staff runs the setup panel (the interactive picker)
  eventpanel: { label: "Mini Event Setup (Staff)", command: "eventpanel" },

  // where the public “Join Event” announcement panel gets posted
  eventannounce: { label: "Mini Event Announcements (Public)", command: "eventannounce" },

  // optional, if you still want it
  adminpanel: { label: "Admin Panel", command: "adminpanel" },
};

async function getGuildCfg(guildId) {
  const gid = String(guildId);

  const res = await query(
    `
    SELECT panel_key, channel_id, updated_at
    FROM panel_channels
    WHERE guild_id = $1
    `,
    [gid]
  );

  const cfg = {
    panels: {},
    updatedAt: null,
  };

  let newest = 0;

  for (const row of res.rows) {
    const key = String(row.panel_key || "").trim();

    // ignore legacy/unknown junk if any somehow exists
    if (!PANELS[key]) continue;

    cfg.panels[key] = String(row.channel_id || "").trim();

    const t = Date.parse(String(row.updated_at || ""));
    if (Number.isFinite(t) && t > newest) newest = t;
  }

  if (newest > 0) {
    cfg.updatedAt = new Date(newest).toLocaleString();
  }

  return cfg;
}

function pickChannelFromArgs(message, arg) {
  const mentioned = message.mentions.channels?.first?.();
  if (mentioned) return mentioned;

  const id = String(arg || "").replace(/[<#>]/g, "").trim();
  if (!id) return null;

  return message.guild.channels.cache.get(id) || null;
}

function validatePostableChannel(ch) {
  if (!ch) return { ok: false, msg: "Channel not found." };

  // Allow TEXT + ANNOUNCEMENT channels
  if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) {
    return { ok: false, msg: "That channel must be a text or announcement channel." };
  }

  return { ok: true, channel: ch };
}

async function buildSettingsEmbed(guildId) {
  const cfg = await getGuildCfg(guildId);

  const e = new EmbedBuilder()
    .setTitle("Panel Channel Settings")
    .setDescription("Shows where each panel is configured to post.")
    .setTimestamp(new Date());

  for (const [key, meta] of Object.entries(PANELS)) {
    const chId = cfg.panels?.[key] || null;
    const value = chId ? `<#${chId}>` : "_Not set_";
    e.addFields({ name: meta.label, value, inline: false });
  }

  e.addFields({
    name: "Commands",
    value: "`-setpanel <panel> <#channel>`\n`-clearpanel <panel>`\n`-panelsettings`",
    inline: false,
  });

  e.addFields({
    name: "Valid panels",
    value: Object.keys(PANELS)
      .map((k) => `\`${k}\``)
      .join(", "),
    inline: false,
  });

  if (cfg.updatedAt) {
    e.setFooter({ text: `Last updated: ${cfg.updatedAt}` });
  }

  return e;
}

// ---- register (implementation) ----
function registerPanelSettingsImpl(client, { prefix = "-" } = {}) {
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!message.guild) return;
      if (message.author?.bot) return;

      const content = String(message.content ?? "");
      if (!content.startsWith(prefix)) return;

      const raw = content.slice(prefix.length).trim();
      if (!raw) return;

      const parts = raw.split(/\s+/);
      const cmd = (parts.shift() || "").toLowerCase();
      const args = parts;

      if (cmd !== "panelsettings" && cmd !== "setpanel" && cmd !== "clearpanel") return;

      // ✅ Central gate: adminpanel access (parent) should pass this automatically
      const ok = await requireStaffCommand(message, prefix, cmd);
      if (!ok) return;

      // -panelsettings
      if (cmd === "panelsettings") {
        const embed = await buildSettingsEmbed(message.guild.id);
        await message.reply({ embeds: [embed] }).catch(() => null);
        return;
      }

      // -setpanel <panel> <#channel|id>
      if (cmd === "setpanel") {
        const panelKey = String(args[0] || "").toLowerCase();
        if (!PANELS[panelKey]) {
          await message.reply(`Unknown panel. Valid: ${Object.keys(PANELS).join(", ")}`).catch(() => null);
          return;
        }

        const ch = pickChannelFromArgs(message, args[1]);
        const chk = validatePostableChannel(ch);
        if (!chk.ok) {
          await message.reply(chk.msg).catch(() => null);
          return;
        }

        await query(
          `
          INSERT INTO panel_channels (guild_id, panel_key, channel_id, updated_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (guild_id, panel_key)
          DO UPDATE SET
            channel_id = EXCLUDED.channel_id,
            updated_at = NOW()
          `,
          [String(message.guild.id), panelKey, String(chk.channel.id)]
        );

        const embed = await buildSettingsEmbed(message.guild.id);
        await message.reply({ embeds: [embed] }).catch(() => null);
        return;
      }

      // -clearpanel <panel>
      if (cmd === "clearpanel") {
        const panelKey = String(args[0] || "").toLowerCase();
        if (!PANELS[panelKey]) {
          await message.reply(`Unknown panel. Valid: ${Object.keys(PANELS).join(", ")}`).catch(() => null);
          return;
        }

        await query(
          `
          DELETE FROM panel_channels
          WHERE guild_id = $1 AND panel_key = $2
          `,
          [String(message.guild.id), panelKey]
        );

        const embed = await buildSettingsEmbed(message.guild.id);
        await message.reply({ embeds: [embed] }).catch(() => null);
        return;
      }
    } catch (e) {
      console.error("[panelSettings] error:", e);
    }
  });

  console.log("[staffcommands] panelSettings registered");
}

// Export BOTH names so you never get stuck on “Settings” vs “Setting” again.
export const registerPanelSettings = registerPanelSettingsImpl;