import { defineTool } from "@earendil-works/pi-coding-agent";
import { posix } from "node:path";
import { Type } from "typebox";
import { config } from "./config.ts";
import { blobSize, git, gitPage, type GitPage } from "./git.ts";

const operations = ["diff_stat", "diff", "log", "show"];

export function pageText(page: GitPage, offset: number, size = page.total) {
  const note = !page.text && size && offset >= size ? `[no output at offset ${offset}; total ${size} bytes]`
    : page.more ? `\n[truncated: bytes ${offset}-${page.end}${size === undefined ? "; more output exists" : ` of ${size}`}. Call again with offset=${page.end} for the rest, or narrow the request with path.]`
      : offset ? `\n[end of output: bytes ${offset}-${page.end}${size === undefined ? "" : ` of ${size}`}]` : "";
  return page.text + note;
}

export function createReviewGitTool(cwd: string, revisions: Record<string, string>, touched: Set<string>) {
  const names = Object.keys(revisions);
  const accepted = `a 7-40 character lowercase hex commit SHA or one of: ${names.join(", ")}`;
  async function resolveRevision(value: string | undefined, parameter: string, operation: string) {
    if (!value) throw new Error(`${parameter} is required for ${operation}; use ${accepted}`);
    const candidate = Object.hasOwn(revisions, value) ? revisions[value]! : value;
    if (!/^[0-9a-f]{7,40}$/.test(candidate)) {
      throw new Error(`${parameter} must be ${accepted}; ^, ~ and other revision syntax are not accepted: ${value}`);
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
      `Inspect Git history without a shell. Output is capped at ${config.tools.readBytes.max} bytes per call (default ${config.tools.readBytes.default}); when it is truncated the result says so and gives the offset for the next call.`,
      `Revisions are hex commit SHAs or: ${names.join(", ")}.`,
      "Revision syntax such as `^`, `~` or `HEAD@{1}` is not accepted.",
      "operation=diff_stat: requires `from` and `to`; change summary between them (optional `path` limits it to a file or directory).",
      "operation=diff: requires `from` and `to`; patch between them (optional `path` limits it to a file or directory).",
      `operation=log: optional \`revision\` (defaults to head) and \`path\`; commit history ending at \`revision\`, at most ${config.tools.git.maxCommits} commits.`,
      "operation=show: requires both `revision` and `path`; contents of `path` at `revision`.",
    ].join("\n"),
    parameters: Type.Object({
      operation: Type.String({ description: operations.join(" | ") }),
      from: Type.Optional(Type.String({ description: `Start revision; required for diff and diff_stat. ${accepted}` })),
      to: Type.Optional(Type.String({ description: `End revision; required for diff and diff_stat. ${accepted}` })),
      revision: Type.Optional(Type.String({ description: `Revision; required for show, defaults to head for log. ${accepted}` })),
      path: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset into the output, for paging" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: config.tools.readBytes.max, description: `Maximum bytes to return (default ${config.tools.readBytes.default})` })),
    }),
    async execute(_id, { operation, from, to, revision, path: requestedPath, offset = 0, limit = config.tools.readBytes.default }) {
      if (!operations.includes(operation)) throw new Error(`operation must be one of: ${operations.join(", ")}`);
      const path = repositoryPath(requestedPath, operation === "show");
      const scope: string[] = path ? [path] : [];
      let page: GitPage, size: number | undefined;
      if (operation === "diff_stat" || operation === "diff") {
        const range = [await resolveRevision(from, "from", operation), await resolveRevision(to, "to", operation)];
        const options = ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
        page = await gitPage(cwd, [...options, ...(operation === "diff_stat" ? ["--stat=240,200"] : []), ...range, ...(path ? ["--", path] : [])], offset, limit);
        if (!path) {
          const names = await gitPage(cwd, [...options, "--name-only", "-z", ...range], 0, config.tools.git.maxScopeBytes);
          scope.push(...(names.more ? ["."] : names.text.split("\0").filter(Boolean)));
        }
      } else if (operation === "log") {
        const end = await resolveRevision(revision ?? "head", "revision", operation);
        page = await gitPage(cwd, ["--literal-pathspecs", "log", "--no-color", "--no-decorate", `--max-count=${config.tools.git.maxCommits}`,
          "--format=%H %cs %an: %s", end, ...(path ? ["--", path] : [])], offset, limit);
      } else {
        const object = `${await resolveRevision(revision, "revision", operation)}:${path}`;
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
