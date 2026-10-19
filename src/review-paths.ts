// Git owns repository path spelling; filesystems may accept more than one Unicode form.
export function canonicalReviewPaths(scope: string[], tracked: string[]) {
  const spellings = new Map<string, Set<string>>();
  for (const file of tracked) {
    // Directory identities matter for legacy scopes as well as exact files.
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
    // Absence in another snapshot is not uncertainty (e.g. a PR-added file).
    // Only collisions between Git spellings make the identity ambiguous.
    return names ? "." : path;
  }))];
}

export type ReviewScope = { kind: "unknown" } | { kind: "observed"; paths: string[] };

export function reviewScope(paths: string[], tracked: string[]): ReviewScope {
  const canonical = canonicalReviewPaths(paths, tracked);
  return !canonical.length || canonical.includes(".") ? { kind: "unknown" } : { kind: "observed", paths: canonical };
}

// Capture successful reads against their own snapshot, not the comparison trees.
export function observedReviewPaths(paths: string[], tracked: string[]) {
  return canonicalReviewPaths(paths, tracked).map((path) =>
    tracked.includes(path) || path.split("/").includes("node_modules") ? path : ".");
}
