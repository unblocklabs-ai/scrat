import { defineTool } from "@earendil-works/pi-coding-agent";
import { posix } from "node:path";
import { Type } from "typebox";
import { blobSize, git, gitPage, type GitPage } from "./git.ts";

export const defaultBytes = 32 * 1024;
export const maxBytes = 64 * 1024;
const maxCommits = 200;
const maxScopeBytes = 1024 * 1024;
const operations = ["diff_stat", "diff", "log", "show"];

export function pageText(page: GitPage, offset: number, size = page.total) {
  const note = !page.text && size && offset >= size ? `[no output at offset ${offset}; total ${size} bytes]`
    : page.more ? `\n[truncated: bytes ${offset}-${page.end}${size === undefined ? "; more output exists" : ` of ${size}`}. Call again with offset=${page.end} for the rest, or narrow the request with path.]`
      : offset ? `\n[end of output: bytes ${offset}-${page.end}${size === undefined ? "" : ` of ${size}`}]` : "";
  return page.text + note;
}

export function createReviewGitTool(cwd: string, revisions: Record<string, string>, touched: Set<string>) {
  const names = Object.keys(revisions);
  async function resolveRevision(value: string | undefined, parameter: string) {
    const candidate = value && Object.hasOwn(revisions, value) ? revisions[value] : value;
    if (!candidate || !/^[0-9a-f]{7,40}$/.test(candidate)) {
      throw new Error(`${parameter} must be a hex commit SHA or one of: ${names.join(", ")}`);
    }
    try { return await git(cwd, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]); }
    catch { throw new Error(`${parameter} is not a commit available in this checkout: ${value}`); }
  }
  function repositoryPath(value: string | undefined, required: boolean) {
    if (!value) {
      if (required) throw new Error("path is required for this operation");
      return undefined;
    }
    if (value.startsWith("-") || value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) {
      throw new Error(`path must be repository-relative and must not start with "-" or contain "..": ${value}`);
    }
    const normalized = posix.normalize(value);
    return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
  }
  return defineTool({
    name: "git",
    label: "Read-only Git",
    description: [
      "Inspect Git history without a shell. Output is capped at 64 KiB per call (default 32 KiB); when it is truncated the result says so and gives the offset for the next call.",
      `Revisions are hex commit SHAs or: ${names.join(", ")}.`,
      "operation=diff_stat: change summary between `from` and `to` (optional `path` limits it to a file or directory).",
      "operation=diff: patch between `from` and `to` (optional `path` limits it to a file or directory).",
      `operation=log: commit history ending at \`revision\` (default head), at most ${maxCommits} commits, optionally for \`path\`.`,
      "operation=show: contents of `path` at `revision`.",
    ].join("\n"),
    parameters: Type.Object({
      operation: Type.String({ description: operations.join(" | ") }),
      from: Type.Optional(Type.String()), to: Type.Optional(Type.String()), revision: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset into the output, for paging" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxBytes, description: `Maximum bytes to return (default ${defaultBytes})` })),
    }),
    async execute(_id, { operation, from, to, revision, path: requestedPath, offset = 0, limit = defaultBytes }) {
      if (!operations.includes(operation)) throw new Error(`operation must be one of: ${operations.join(", ")}`);
      const path = repositoryPath(requestedPath, operation === "show");
      const scope: string[] = path ? [path] : [];
      let page: GitPage, size: number | undefined;
      if (operation === "diff_stat" || operation === "diff") {
        const range = [await resolveRevision(from, "from"), await resolveRevision(to, "to")];
        const options = ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
        page = await gitPage(cwd, [...options, ...(operation === "diff_stat" ? ["--stat=240,200"] : []), ...range, ...(path ? ["--", path] : [])], offset, limit);
        if (!path) {
          const names = await gitPage(cwd, [...options, "--name-only", "-z", ...range], 0, maxScopeBytes);
          scope.push(...(names.more ? ["."] : names.text.split("\0").filter(Boolean)));
        }
      } else if (operation === "log") {
        const end = await resolveRevision(revision ?? "head", "revision");
        page = await gitPage(cwd, ["--literal-pathspecs", "log", "--no-color", "--no-decorate", `--max-count=${maxCommits}`,
          "--format=%H %cs %an: %s", end, ...(path ? ["--", path] : [])], offset, limit);
      } else {
        const object = `${await resolveRevision(revision, "revision")}:${path}`;
        page = await gitPage(cwd, ["show", object], offset, limit);
        if (page.more) size = await blobSize(cwd, object);
      }
      for (const entry of scope) touched.add(entry);
      if (operation !== "show" && !page.more) page = { ...page, text: page.text.trimEnd() };
      const text = pageText(page, offset, size);
      return { content: [{ type: "text", text: text || "(no output)" }], details: { operation, offset, bytes: page.end } };
    },
  });
}
