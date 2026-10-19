import { mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-sqlite";

mkdirSync("data", { recursive: true });

export const db = drizzle({ connection: { path: "data/scrat.sqlite", timeout: 5000 } });
