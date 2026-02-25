/** @format */
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function ensureDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS panel_channels (
      guild_id TEXT NOT NULL,
      panel_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, panel_key)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS event_panels (
      message_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      panel_type TEXT NOT NULL,
      status TEXT NOT NULL,
      selected_event_key TEXT,
      settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      announced_channel_id TEXT,
      announced_message_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      started_by TEXT
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS live_panels (
      guild_id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      started_at TIMESTAMPTZ,
      time_limit_seconds INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}