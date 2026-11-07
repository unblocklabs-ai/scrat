import { createHash } from "node:crypto";
import type { GithubItem } from "./github-types.ts";
import type { ActionSettings, LabelCategory } from "./manifests.ts";

const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function categoriesFor(settings: Pick<ActionSettings, "targets" | "issue_labels" | "pr_labels">, kind: "issue" | "pr") {
  if (!settings.targets?.includes(kind === "pr" ? "prs" : "issues")) return [];
  return (kind === "pr" ? settings.pr_labels : settings.issue_labels) ?? [];
}

export function itemLabelKey(item: GithubItem, categories: readonly LabelCategory[]) {
  const pr = "head" in item ? item : undefined;
  return fingerprint({ title: item.title, body: item.body ?? "", headSha: pr?.head.sha, baseBranch: pr?.base.ref, categories });
}
