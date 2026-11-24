import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createFindTool, createGrepTool, getAgentDir } from "@earendil-works/pi-coding-agent";

await createFindTool(process.cwd()).execute("install-find", { pattern: "package.json", limit: 1 });
await createGrepTool(process.cwd()).execute("install-grep", { pattern: '"name"', path: "package.json", limit: 1 });
const piRg = join(getAgentDir(), "bin", process.platform === "win32" ? "rg.exe" : "rg");
const hasPiRg = (() => { try { accessSync(piRg, constants.X_OK); return true; } catch { return false; } })();
const rg = hasPiRg ? piRg : spawnSync("rg", ["--version"], { stdio: "ignore", timeout: 3000 }).status === 0 ? "rg" : undefined;
if (!rg) throw new Error("ripgrep (rg) binary was not found after tool preparation");
console.log(`Pi search tools ready (rg: ${rg})`);
