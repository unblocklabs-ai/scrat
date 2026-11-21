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
