import { defineTool } from "@earendil-works/pi-coding-agent";
import { posix } from "node:path";
import { Type } from "typebox";
import { git } from "./git.ts";

const defaultBytes = 32 * 1024;
const maxBytes = 64 * 1024;
const maxCommits = 200;
const operations = ["diff_stat", "diff", "log", "show"];

// Read-only Git for sessions without Bash. Every path it touches is reported to
// `touched` so freshness sees the same scope as the wrapped read tool.
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
    // Git paths have one spelling: ./src/app.ts and src/app.ts must be one scope entry.
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
      "operation=diff: patch between `from` and `to` limited to `path`.",
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
      const path = repositoryPath(requestedPath, operation === "diff" || operation === "show");
      const scope: string[] = path ? [path] : [];
      let output: string;
      try {
        if (operation === "diff_stat" || operation === "diff") {
          const range = [await resolveRevision(from, "from"), await resolveRevision(to, "to")];
          const options = ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
          const limited = path ? ["--", path] : [];
          output = await git(cwd, [...options, ...(operation === "diff_stat" ? ["--stat=240,200"] : []), ...range, ...limited]);
          if (operation === "diff_stat" && !path) {
            scope.push(...(await git(cwd, [...options, "--name-only", "-z", ...range])).split("\0").filter(Boolean));
          }
        } else if (operation === "log") {
          const end = await resolveRevision(revision ?? "head", "revision");
          output = await git(cwd, ["--literal-pathspecs", "log", "--no-color", "--no-decorate", `--max-count=${maxCommits}`,
            "--format=%H %cs %an: %s", end, ...(path ? ["--", path] : [])]);
        } else {
          output = await git(cwd, ["show", `${await resolveRevision(revision, "revision")}:${path}`]);
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          throw new Error("Git output exceeds 16 MiB; narrow the request with path or use diff_stat first");
        }
        throw error;
      }
      for (const entry of scope) touched.add(entry);
      const bytes = Buffer.from(output);
      let end = Math.min(bytes.length, offset + limit);
      // Never end a page inside a multibyte character; the next offset starts on one.
      if (end < bytes.length) while (end > offset + 1 && (bytes[end]! & 0xc0) === 0x80) end--;
      const body = bytes.subarray(offset, end).toString();
      const note = offset >= bytes.length && bytes.length ? `[no output at offset ${offset}; total ${bytes.length} bytes]`
        : end < bytes.length ? `\n[truncated: bytes ${offset}-${end} of ${bytes.length}. Call again with offset=${end} for the rest, or narrow the request with path.]`
          : offset ? `\n[end of output: bytes ${offset}-${end} of ${bytes.length}]` : "";
      return { content: [{ type: "text", text: (body || (bytes.length ? "" : "(no output)")) + note }], details: { operation, offset, bytes: bytes.length } };
    },
  });
}
