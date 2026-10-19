import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { git } from "./git.ts";
import { canonicalReviewPaths } from "./review-paths.ts";

function affectsPaths(changed: string[], scope: string[]) {
  return changed.length > 0 && (!scope.length || changed.some((file) => scope.includes(file)));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lockfileChanged(before: string, after: string, dependencies: Set<string>) {
  const documents = [before, after].map((text) => {
    const value: unknown = parse(text);
    if (!record(value)) throw new Error("Unrecognized lockfile");
    const { packages = {}, snapshots = {}, ...rest } = value;
    if (!record(packages) || !record(snapshots)) throw new Error("Unrecognized lockfile records");
    return { packages, snapshots, rest };
  });
  // Importers, settings and unknown sections are not proven unrelated.
  if (!isDeepStrictEqual(documents[0].rest, documents[1].rest)) return true;
  for (const section of ["packages", "snapshots"] as const) {
    const previous = documents[0][section], current = documents[1][section];
    for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
      if (isDeepStrictEqual(previous[key], current[key])) continue;
      const name = key.match(/^((?:@[^/]+\/)?[^@/:]+)@.+$/)?.[1];
      if (!name || dependencies.has(name) || (previous[key] !== undefined && !record(previous[key]))
        || (current[key] !== undefined && !record(current[key]))) return true;
    }
  }
  return false;
}

export async function reviewChanges(repository: string, before: string, after: string, scope: string[]) {
  const paths = (await git(repository, ["diff", "--name-only", "--no-renames", "-z", before, after])).split("\0").filter(Boolean);
  if (!scope.length || scope.includes(".")) return { paths, relevant: paths.length > 0 };
  const tracked = await Promise.all([before, after].map((sha) => git(repository, ["ls-tree", "-r", "--name-only", "-z", sha])));
  scope = canonicalReviewPaths(scope, tracked.flatMap((files) => files.split("\0").filter(Boolean)));
  if (scope.includes(".")) return { paths, relevant: paths.length > 0 };
  const metadata = new Set(["package.json", "pnpm-lock.yaml"]);
  if (affectsPaths(paths.filter((path) => !metadata.has(path)), scope)) return { paths, relevant: true };
  const dependencies = new Set(scope.flatMap((path) => [...path.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)]
    .map((match) => match[1]).filter((name) => !name.startsWith("."))));
  try {
    if (paths.includes("package.json") && scope.includes("package.json")) {
      const manifests = await Promise.all([before, after].map(async (sha) => {
        const manifest: { devDependencies?: Record<string, string>; [key: string]: unknown } = JSON.parse(await git(repository, ["show", `${sha}:package.json`]));
        const { devDependencies = {}, ...rest } = manifest;
        return { devDependencies, rest };
      }));
      if (!isDeepStrictEqual(manifests[0].rest, manifests[1].rest)
        || [...dependencies].some((name) => manifests[0].devDependencies[name] !== manifests[1].devDependencies[name])) return { paths, relevant: true };
    }
    if (paths.includes("pnpm-lock.yaml") && (scope.includes("pnpm-lock.yaml") || dependencies.size)) {
      const contents = await Promise.all([before, after].map((sha) => git(repository, ["show", `${sha}:pnpm-lock.yaml`])));
      if (lockfileChanged(contents[0], contents[1], dependencies)) return { paths, relevant: true };
    }
  } catch {
    // Missing or malformed metadata is itself worth reviewing, not evidence of no impact.
    return { paths, relevant: true };
  }
  return { paths, relevant: false };
}
