import { mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-sqlite";
import { startOperation } from "./logging.ts";

function openDatabase() {
  const operation = startOperation("database.open", { database: "data/scrat.sqlite" });
  try {
    mkdirSync("data", { recursive: true });
    const database = drizzle("data/scrat.sqlite");
    operation.complete();
    return database;
  } catch (err) {
    operation.fail(err);
    throw err;
  }
}

export const db = openDatabase();
