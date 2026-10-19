import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configUrl } from "./config.ts";

// One Pi runtime serves every session and startup check in the process; a failed creation is not cached so the next call retries.
let modelRuntimeCreation: Promise<ModelRuntime> | undefined;
export function sharedModelRuntime() {
  modelRuntimeCreation ??= ModelRuntime.create({
    modelsPath: fileURLToPath(configUrl),
    modelsStorePath: resolve("data/pi-models-store.json"),
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
