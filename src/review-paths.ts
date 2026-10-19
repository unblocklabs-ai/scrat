// Git owns repository path spelling; filesystems may accept more than one Unicode form.
export function canonicalReviewPaths(scope: string[], tracked: string[]) {
  const spellings = new Map<string, Set<string>>();
  for (const path of tracked) {
    const key = path.normalize("NFC");
    const names = spellings.get(key) ?? new Set<string>();
    names.add(path);
    spellings.set(key, names);
  }
  return [...new Set(scope.map((path) => {
    const names = spellings.get(path.normalize("NFC"));
    if (names?.size === 1) return names.values().next().value!;
    if (!names && path.split("/").includes("node_modules")) return path;
    // Unknown or ambiguous source identity cannot prove a base change unrelated.
    return ".";
  }))];
}
