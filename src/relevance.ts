import { isDeepStrictEqual } from "node:util";
import { git } from "./git.ts";

function affectsPaths(changed: string[], scope: string[]) {
  return changed.length > 0 && (!scope.length || changed.some((file) => scope.includes(file)));
}

export async function reviewChanges(repository: string, before: string, after: string, scope: string[]) {
  const paths = (await git(repository, ["diff", "--name-only", "--no-renames", "-z", before, after])).split("\0").filter(Boolean);
  if (!scope.length) return { paths, relevant: paths.length > 0 };
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
      const diff = await git(repository, ["diff", "--unified=0", before, after, "--", "pnpm-lock.yaml"]);
      const changedPackages = [...diff.matchAll(/^[+-] {2}['"]?((?:@[^/'"\s]+\/)?[^@:'"\s]+)@[^:\n]+:\s*$/gm)].map((match) => match[1]);
      // Unknown lockfile edits remain conservative; recognized unrelated package updates do not widen scope.
      if (!changedPackages.length || changedPackages.some((name) => dependencies.has(name))) return { paths, relevant: true };
    }
  } catch {
    // Missing or malformed metadata is itself worth reviewing, not evidence of no impact.
    return { paths, relevant: true };
  }
  return { paths, relevant: false };
}
