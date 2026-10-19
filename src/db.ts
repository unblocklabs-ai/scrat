import { mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-sqlite";

mkdirSync("data", { recursive: true, mode: 0o700 });

export const db = drizzle("data/scrat.sqlite");
