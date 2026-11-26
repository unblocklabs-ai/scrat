import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { config } from "./config.ts";

mkdirSync("data", { recursive: true });

const client = new DatabaseSync("data/scrat.sqlite", { timeout: config.harness.sqliteBusyTimeoutMs });
client.exec(`PRAGMA busy_timeout = ${config.harness.sqliteBusyTimeoutMs}`);
const currentMode = (client.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined)?.journal_mode;
if (currentMode?.toLowerCase() !== "wal") client.exec("PRAGMA journal_mode = WAL");
client.exec("PRAGMA synchronous = NORMAL");

export const db = drizzle({ client });
