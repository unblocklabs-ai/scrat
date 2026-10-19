import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { actionIds } from "./actions.ts";
import { config, configUrl, thinkingLevels } from "./config.ts";

type Entry = { provider: string; model: string; thinkingLevel: string };

// Fails before any worker claims, so a bad static setting stops startup instead of failing tasks one by one.
export async function validateStaticConfig(settings: { actions: Record<string, Entry & { skill: string; reviewers?: Entry[] }> } = config) {
  const modelRuntime = await ModelRuntime.create({
    modelsPath: fileURLToPath(configUrl),
    modelsStorePath: resolve("data/pi-models-store.json"),
  });
  const problems: string[] = [];
  const checkEntry = (label: string, { provider, model, thinkingLevel }: Entry) => {
    if (!(thinkingLevels as readonly string[]).includes(thinkingLevel)) problems.push(`${label}: invalid thinking level ${thinkingLevel}`);
    if (!modelRuntime.getModel(provider, model)) problems.push(`${label}: no Pi model ${provider}/${model}${modelRuntime.getError() ? ` (${modelRuntime.getError()})` : ""}`);
  };
  for (const action of actionIds) {
    const entry = settings.actions[action];
    if (!entry) { problems.push(`${action}: missing from configuration`); continue; }
    checkEntry(action, entry);
    entry.reviewers?.forEach((reviewer, index) => checkEntry(`${action} reviewer ${index + 1}`, reviewer));
    const skill = fileURLToPath(new URL(entry.skill, configUrl));
    if (!await access(skill).then(() => true, () => false)) problems.push(`${action}: skill file not found: ${skill}`);
  }
  if (problems.length) throw new Error(`Invalid Scrat configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
}
