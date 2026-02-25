/* @format */
import "dotenv/config";
import { Client, GatewayIntentBits, Events } from "discord.js";
import { ensureDb } from "./db.js";

// keep only what you actually use
import { registerAdminPanel } from "../staffcommands/botcommands.js";
import { registerEventPanel } from "../miniEvents/eventPanel.js";
import { registerPanelSettings } from "../staffcommands/panelSettings.js";

console.log("[boot] src/index.js loaded");

const PREFIX = "-";

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) throw new Error("Missing DISCORD_TOKEN in .env");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  try {
    registerPanelSettings(client, { prefix: PREFIX });
    console.log("[boot] panelSettings module registered");
  } catch (e) {
    console.error("[boot] registerPanelSettings crashed:", e);
  }

  try {
    registerEventPanel(client, { prefix: PREFIX });
    console.log("[boot] eventpanel module registered");
  } catch (e) {
    console.error("[boot] registerEventPanel crashed:", e);
  }

  try {
    registerAdminPanel(client, { prefix: PREFIX, commands: ["adminpanel"] });
    console.log("[boot] admin panel module registered");
  } catch (e) {
    console.error("[boot] registerAdminPanel crashed:", e);
  }
});

async function bootstrap() {
  try {
    console.log("[boot] connecting to postgres...");
    await ensureDb();
    console.log("[boot] postgres ready");
  } catch (e) {
    console.error("[boot] database init failed:", e);
    process.exit(1);
  }

  await client.login(token);
}

bootstrap().catch((e) => {
  console.error("[boot] fatal startup error:", e);
  process.exit(1);
});