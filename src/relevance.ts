import { isDeepStrictEqual } from "node:util";
import { config } from "./config.ts";
import { changedPaths, git } from "./git.ts";
import { affectsPaths, lockfileChanged } from "./lockfile-impact.ts";
import { reviewScope } from "./review-paths.ts";

type Review = { paths: string[]; relevant: boolean; degraded?: true };

const reviewCache = new Map<string, Promise<Review>>();
const treeCache = new Map<string, Promise<string>>();

function memoize<T>(cache: Map<string, Promise<T>>, limit: number, key: string, load: () => Promise<T>) {
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const pending = load();
  cache.set(key, pending);
  if (cache.size > limit) cache.delete(cache.keys().next().value as string);
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

function listTree(repository: string, sha: string) {
  return memoize(treeCache, config.harness.treeCacheLimit, JSON.stringify([repository, sha]), () => git(repository, ["ls-tree", "-r", "--name-only", "-z", sha]));
}

export async function reviewChanges(repository: string, before: string, after: string, scope: string[]) {
  const key = JSON.stringify([repository, before, after, [...new Set(scope)].sort()]);
  const pending = memoize(reviewCache, config.harness.reviewCacheLimit, key, () => computeReview(repository, before, after, scope));
  const review = await pending;
  if (review.degraded && reviewCache.get(key) === pending) reviewCache.delete(key);
  return { paths: [...review.paths], relevant: review.relevant };
}

async function computeReview(repository: string, before: string, after: string, scope: string[]): Promise<Review> {
  const paths = await changedPaths(repository, before, after);
  if (!scope.length || scope.includes(".")) return { paths, relevant: paths.length > 0 };
  const tracked = await Promise.all([before, after].map((sha) => listTree(repository, sha)));
  const observed = reviewScope(scope, tracked.flatMap((files) => files.split("\0").filter(Boolean)));
  if (!observed) return { paths, relevant: paths.length > 0 };
  scope = observed;
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
    return { paths, relevant: true, degraded: true };
  }
  return { paths, relevant: false };
}
