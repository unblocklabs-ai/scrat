import { mkdirSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

mkdirSync("data", { recursive: true });

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  dbCredentials: { url: "./data/scrat.sqlite" },
});
