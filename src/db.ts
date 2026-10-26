import { mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-sqlite";
import { config } from "./config.ts";

mkdirSync("data", { recursive: true });

export const db = drizzle({ connection: { path: "data/scrat.sqlite", timeout: config.harness.sqliteBusyTimeoutMs } });
