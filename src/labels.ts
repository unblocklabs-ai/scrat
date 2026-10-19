import type { EventReferences } from "./events.ts";
import { addLabels, removeLabels } from "./github.ts";
import type { PrGrade } from "./results.ts";

export const gradeLabels = {
  S: "S · Exceptional", A: "A · Strong", B: "B · Solid",
  C: "C · Needs work", D: "D · Weak", F: "F · Unsafe or broken",
} satisfies Record<PrGrade, string>;

export async function reconcileLabels(repository: string, number: number, {
  current, desired, managed,
}: {
  current: readonly (string | { name?: string })[];
  desired: readonly string[];
  managed: readonly string[];
}, references: EventReferences = {}) {
  const present = current.map((label) => typeof label === "string" ? label : label.name ?? "");
  const existing = new Set(present.map((name) => name.toLowerCase()));
  const wanted = new Set(desired.map((name) => name.toLowerCase()));
  const owned = new Set(managed.map((name) => name.toLowerCase()));
  const add = desired.filter((name) => !existing.has(name.toLowerCase()));
  const remove = present.filter((name) => owned.has(name.toLowerCase()) && !wanted.has(name.toLowerCase()));
  if (add.length) await addLabels(repository, number, add, references);
  await removeLabels(repository, number, remove, references);
}
