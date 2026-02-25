/* @format */
// createLobby.js
import "dotenv/config";

import { loadYolkbotClient } from "./src/yolkbotClient.js";
import { createLobby } from "./src/yolkbotIndex.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;

    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next && !next.startsWith("--") ? next : "true";
    out[key] = val;
    if (val !== "true") i++;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  const mode = (args.mode || "kotc").toLowerCase();
  const region = args.region || "uscentral";
  const map = args.map || "cluckgrounds";
  const botName = args.botName || process.env.YOLKBOT_BOT_NAME || "Shell Drill Bot";

  // Dummy IDs since you’re CLI testing, not Discord-routing yet
  const params = {
    mode,
    guildId: "cli",
    channelId: "cli",
    createdBy: "cli",
    region,
    map,
    options: {}
  };

  const client = await loadYolkbotClient({ botName });

  const lobby = await createLobby(client, params);

  console.log("\n✅ Lobby created + joined");
  console.log("Mode:   ", lobby.mode);
  console.log("Region: ", lobby.region);
  console.log("Map:    ", lobby.map);
  console.log("Code:   ", lobby.gameId);
  console.log("\nTest it by joining the private game with that code.\n");
}

main().catch((err) => {
  console.error("\n❌ Failed to create lobby");
  console.error(err?.stack || err);
  process.exitCode = 1;
});
