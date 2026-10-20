import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";

let modelRuntimeCreation: Promise<ModelRuntime> | undefined;
export function sharedModelRuntime() {
  const modelsPath = resolve("data/pi-models.json");
  modelRuntimeCreation ??= Promise.resolve().then(() => {
    mkdirSync(resolve("data"), { recursive: true });
    const models = JSON.stringify({ providers: config.providers }, null, 2) + "\n";
    if (!existsSync(modelsPath) || readFileSync(modelsPath, "utf8") !== models) {
      writeFileSync(`${modelsPath}.${process.pid}`, models, { mode: 0o600 });
      renameSync(`${modelsPath}.${process.pid}`, modelsPath);
    }
    return ModelRuntime.create({ modelsPath, modelsStorePath: resolve("data/pi-models-store.json") });
  }).catch((error: unknown) => {
    modelRuntimeCreation = undefined;
    throw error;
  });
  return modelRuntimeCreation;
}

export function dropModelRuntime() {
  modelRuntimeCreation = undefined;
}
