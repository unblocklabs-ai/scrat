import { mkdirSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

mkdirSync("data", { recursive: true, mode: 0o700 });

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  dbCredentials: { url: "./data/scrat.sqlite" },
});
