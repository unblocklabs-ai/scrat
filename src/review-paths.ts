import { gitList } from "./git.ts";

export function canonicalReviewPaths(scope: string[], tracked: string[]) {
  const files = new Map<string, Set<string>>();
  const directories = new Set<string>();
  for (const file of tracked) {
    const fileKey = file.normalize("NFC");
    const names = files.get(fileKey) ?? new Set<string>();
    names.add(file);
    files.set(fileKey, names);
    const parts = file.split("/");
    for (let end = 1; end < parts.length; end++) {
      directories.add(parts.slice(0, end).join("/").normalize("NFC"));
    }
  }
  const result: string[] = [];
  for (const raw of scope) {
    const path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
    if (!path) continue;
    if (path === ".") { result.push("."); continue; }
    const key = path.normalize("NFC");
    const names = files.get(key);
    if (names) result.push(...names);
    else if (!directories.has(key)) result.push(path);
  }
  return [...new Set(result)];
}

export function reviewScope(paths: string[], tracked: string[]) {
  const canonical = canonicalReviewPaths(paths, tracked);
  return !canonical.length || canonical.includes(".") ? undefined : canonical;
}

export async function retainReviewScope({
  repositoryPath, mainSha, headSha, diffPaths, paths, previousMainSha, previousPaths, changedPaths,
}: {
  repositoryPath: string;
  mainSha: string;
  headSha: string;
  diffPaths: readonly string[];
  paths: readonly string[];
  previousMainSha?: string | null;
  previousPaths?: string[];
  changedPaths?: readonly string[];
}) {
  const mainOnly = new Set(changedPaths);
  const mainTracked = await gitList(repositoryPath, ["ls-tree", "-r", "--name-only", "-z", mainSha]);
  const headTracked = headSha !== mainSha ? await gitList(repositoryPath, ["ls-tree", "-r", "--name-only", "-z", headSha]) : [];
  const previousMainTracked = previousMainSha && previousMainSha !== mainSha && previousMainSha !== headSha
    ? await gitList(repositoryPath, ["ls-tree", "-r", "--name-only", "-z", previousMainSha]).catch(() => []) : [];
  const tracked = headTracked.length || previousMainTracked.length ? [...mainTracked, ...headTracked, ...previousMainTracked] : mainTracked;
  const prior = canonicalReviewPaths(previousPaths ?? [], tracked).filter((path) => path !== ".");
  return [...new Set([...prior, ...diffPaths, ...paths.filter((path) => !mainOnly.has(path))])];
}
