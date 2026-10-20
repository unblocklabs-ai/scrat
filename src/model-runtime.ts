import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";

// One Pi runtime serves every session and startup check in the process; a failed creation is not cached so the next call retries.
let modelRuntimeCreation: Promise<ModelRuntime> | undefined;
export function sharedModelRuntime() {
  // Pi reads providers from a file, so hand it the merged ones (placeholders such as ${ENV} stay literal for Pi to expand).
  const modelsPath = resolve("data/pi-models.json");
  modelRuntimeCreation ??= Promise.resolve().then(() => {
    mkdirSync(resolve("data"), { recursive: true });
    // Other Scrat processes and Pi's refresh read this file, so replace it atomically and only when it changes.
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

// Pi reports an unreadable or invalid models config without rejecting; the next call rebuilds the runtime.
export function dropModelRuntime() {
  modelRuntimeCreation = undefined;
}
