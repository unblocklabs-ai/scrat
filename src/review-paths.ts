export function canonicalReviewPaths(scope: string[], tracked: string[]) {
  const spellings = new Map<string, Set<string>>();
  for (const file of tracked) {
    const parts = file.split("/");
    for (let end = 1; end <= parts.length; end++) {
      const path = parts.slice(0, end).join("/");
      const key = path.normalize("NFC");
      const names = spellings.get(key) ?? new Set<string>();
      names.add(path);
      spellings.set(key, names);
    }
  }
  return [...new Set(scope.map((path) => {
    const names = spellings.get(path.normalize("NFC"));
    if (names?.size === 1) return names.values().next().value!;
    return names ? "." : path;
  }))];
}

export function reviewScope(paths: string[], tracked: string[]) {
  const canonical = canonicalReviewPaths(paths, tracked);
  return !canonical.length || canonical.includes(".") ? undefined : canonical;
}
