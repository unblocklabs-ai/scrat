import { defineTool } from "@earendil-works/pi-coding-agent";
import { posix } from "node:path";
import type { Logger } from "pino";
import { Type } from "typebox";
import { config } from "./config.ts";
import { blobSize, commitOf, gitPage, type GitPage } from "./git.ts";

const operations = ["diff_stat", "diff", "log", "show"];
const lockfilePathRe = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock)$/;
const lockfileEntryRe = /^([+-])\s{0,6}(?:'?(@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?@[^:\s'"]+)'?:|"node_modules\/([^"]+)":|"(@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)":\s*"([^"]+)")/;

function parseNumstatZ(text: string) {
  const entries: Array<{ path: string; ins: string; del: string }> = [];
  for (const record of text.split("\0")) {
    if (!record) continue;
    const first = record.indexOf("\t"), second = first >= 0 ? record.indexOf("\t", first + 1) : -1;
    if (first < 0 || second < 0) continue;
    entries.push({ ins: record.slice(0, first), del: record.slice(first + 1, second), path: record.slice(second + 1) });
  }
  return entries;
}

function summarizeLockfileEntries(diffText: string, maxEntries = 30) {
  const added = new Set<string>(), removed = new Set<string>();
  for (const line of diffText.split("\n")) {
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const match = lockfileEntryRe.exec(line);
    if (!match) continue;
    const label = match[2] ?? match[3] ?? (match[4] && match[5] ? `${match[4]}@${match[5]}` : undefined);
    if (!label) continue;
    if (match[1] === "+") added.add(label); else removed.add(label);
    if (added.size + removed.size >= maxEntries * 2) break;
  }
  const lines: string[] = [];
  if (added.size) lines.push(`Added/updated entries (sample): ${[...added].slice(0, maxEntries).join(", ")}${added.size > maxEntries ? ", ..." : ""}`);
  if (removed.size) lines.push(`Removed entries (sample): ${[...removed].slice(0, maxEntries).join(", ")}${removed.size > maxEntries ? ", ..." : ""}`);
  return lines.join("\n");
}

function formatOmittedGenerated(entries: Array<{ path: string; ins: string; del: string }>) {
  const shown = entries.slice(0, 20).map(({ path, ins, del }) => `${path} (+${ins}/-${del})`).join(", ");
  const more = entries.length > 20 ? `, and ${entries.length - 20} more` : "";
  return `[omitted ${entries.length} generated/lockfile diff(s): ${shown}${more}. Pass include_generated=true with a specific path if you need raw generated lines.]`;
}

const diffHeaderRe = /^diff --git (?:"[abciow]\/((?:[^"\\]|\\.)+)"|[abciow]\/(.+?)) (?:"[abciow]\/((?:[^"\\]|\\.)+)"|[abciow]\/(.+))$/;
const diffMetaLineRe = /^(?:index [0-9a-f]+\.\.[0-9a-f]+|new file mode |deleted file mode |old mode |new mode |similarity index |rename (?:from|to) |copy (?:from|to) |Binary files |GIT binary patch|--- |(?:\+\+\+ )|@@ )/;

function decodeGitPath(raw: string, quoted: boolean) {
  return quoted ? raw.replace(/\\(["\\])/g, "$1") : raw;
}

export function omitGeneratedFromUnifiedDiff(rawText: string, patterns: readonly RegExp[], minBytes: number, artifactNote = ""): { text: string; omitted: string[] } {
  if (!patterns.length || !rawText.includes("diff --git ")) return { text: rawText, omitted: [] };
  const sections = rawText.split(/(?=^diff --git )/m);
  const out: string[] = [];
  const omitted: string[] = [];
  for (const section of sections) {
    const firstNl = section.indexOf("\n");
    const firstLine = (firstNl >= 0 ? section.slice(0, firstNl) : section).replace(/\r$/, "");
    const match = diffHeaderRe.exec(firstLine);
    if (!match) { out.push(section); continue; }
    const restStart = firstNl >= 0 ? firstNl + 1 : section.length;
    const secondNl = section.indexOf("\n", restStart);
    const secondLine = (secondNl >= 0 ? section.slice(restStart, secondNl) : section.slice(restStart)).replace(/\r$/, "");
    if (!diffMetaLineRe.test(secondLine)) { out.push(section); continue; }
    const pathA = decodeGitPath(match[1] ?? match[2]!, match[1] !== undefined);
    const pathB = decodeGitPath(match[3] ?? match[4]!, match[3] !== undefined);
    const targetPath = pathB && pathB !== "/dev/null" ? pathB : pathA;
    if (!patterns.some((re) => re.test(pathA) || re.test(pathB)) || Buffer.byteLength(section, "utf8") <= minBytes) {
      out.push(section);
      continue;
    }
    let ins = 0, del = 0;
    for (const line of section.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) ins++;
      else if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    const lockSummary = lockfilePathRe.test(targetPath) ? summarizeLockfileEntries(section) : "";
    omitted.push(`${targetPath} (+${ins}/-${del})`);
    out.push([
      firstLine,
      lockSummary,
      `[generated/lockfile diff omitted (>${minBytes} bytes; +${ins}/-${del} lines${artifactNote}). Pass raw: true if you need raw generated lines.]\n`,
    ].filter(Boolean).join("\n"));
  }
  return omitted.length ? { text: out.join(""), omitted } : { text: rawText, omitted: [] };
}

function pageString(text: string, offset: number, limit: number): GitPage {
  const full = Buffer.from(text, "utf8");
  if (offset >= full.length) return { text: "", end: offset, more: false, total: full.length };
  const slice = full.subarray(offset, offset + limit + 1);
  const more = slice.length > limit;
  let size = more ? limit : slice.length;
  if (more) while (size > 1 && (slice[size]! & 0xc0) === 0x80) size--;
  return { text: slice.subarray(0, size).toString("utf8"), end: offset + size, more, total: full.length };
}

export function pageText(page: GitPage, offset: number, size = page.total) {
  const note = !page.text && size && offset >= size ? `[no output at offset ${offset}; total ${size} bytes]`
    : page.more ? `\n[truncated: bytes ${offset}-${page.end}${size === undefined ? "; more output exists" : ` of ${size}`}. Call again with offset=${page.end} for the rest, or narrow the request with path.]`
      : offset ? `\n[end of output: bytes ${offset}-${page.end}${size === undefined ? "" : ` of ${size}`}]` : "";
  return page.text + note;
}

export function createReviewGitTool(cwd: string, revisions: Record<string, string>, touched: Set<string>, log?: Logger) {
  const names = Object.keys(revisions);
  const accepted = `a 7-40 character lowercase hex commit SHA or one of: ${names.join(", ")}`;
  const generatedPatterns = config.tools.git.generatedPaths.map((pattern) => new RegExp(pattern));
  const isGeneratedPath = (file: string) => generatedPatterns.some((re) => re.test(file));
  async function resolveRevision(value: string | undefined, parameter: string, operation: string) {
    if (!value) throw new Error(`${parameter} is required for ${operation}; use ${accepted}`);
    const candidate = Object.hasOwn(revisions, value) ? revisions[value]! : value;
    if (!/^[0-9a-f]{7,40}$/.test(candidate)) {
      throw new Error(`${parameter} must be ${accepted}; ^, ~ and other revision syntax are not accepted: ${value}`);
    }
    const sha = await commitOf(cwd, candidate);
    if (!sha) throw new Error(`${parameter} is not a commit available in this checkout: ${value}`);
    return sha;
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
      "operation=diff: requires `from` and `to`; patch between them (optional `path` limits it to a file or directory). Large lockfile and generated/minified asset diffs are summarized deterministically by default; pass `include_generated: true` with `path` only when you need raw generated lines.",
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
      include_generated: Type.Optional(Type.Boolean({ description: "For operation=diff, set true to return raw patch lines for lockfiles and generated/minified assets instead of a compact summary" })),
    }),
    async execute(_id, { operation, from, to, revision, path: requestedPath, offset = 0, limit = config.tools.readBytes.default, include_generated = false }) {
      if (!operations.includes(operation)) throw new Error(`operation must be one of: ${operations.join(", ")}`);
      const path = repositoryPath(requestedPath, operation === "show");
      const scope: string[] = [];
      let page: GitPage | undefined, size: number | undefined;
      if (operation === "diff_stat" || operation === "diff") {
        const range = [await resolveRevision(from, "from", operation), await resolveRevision(to, "to", operation)];
        const baseDiffOptions = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
        const options = ["--literal-pathspecs", ...baseDiffOptions];
        if (operation === "diff" && !include_generated && generatedPatterns.length) {
          const numstat = await gitPage(cwd, [...options, "--numstat", "-z", ...range, ...(path ? ["--", path] : [])], 0, config.tools.git.maxScopeBytes);
          if (!numstat.more && !numstat.text.includes("\uFFFD")) {
            const entries = parseNumstatZ(numstat.text);
            const generated = entries.filter((entry) => isGeneratedPath(entry.path));
            const regular = entries.filter((entry) => !isGeneratedPath(entry.path));
            if (generated.length > 0) {
              if (regular.length === 0) {
                const probe = await gitPage(cwd, [...options, ...range, ...(path ? ["--", path] : [])], 0, config.tools.git.generatedDiffBytes + 1);
                if (!probe.more && Buffer.byteLength(probe.text, "utf8") <= config.tools.git.generatedDiffBytes) {
                  page = await gitPage(cwd, [...options, ...range, ...(path ? ["--", path] : [])], offset, limit);
                } else if (generated.length === 1) {
                  const gen = generated[0]!;
                  const [stat, sample] = await Promise.all([
                    gitPage(cwd, [...options, "--stat=240,200", ...range, "--", gen.path], 0, 4096),
                    lockfilePathRe.test(gen.path) ? gitPage(cwd, [...options, ...range, "--", gen.path], 0, 32768) : Promise.resolve(undefined),
                  ]);
                  const lockSummary = sample ? summarizeLockfileEntries(sample.text) : "";
                  const summary = [
                    stat.text.trimEnd(),
                    lockSummary,
                    `[generated/lockfile diff omitted (>${config.tools.git.generatedDiffBytes} bytes; +${gen.ins}/-${gen.del} lines). Pass include_generated=true (with path and optional offset/limit) only if you need raw generated lines.]`,
                  ].filter(Boolean).join("\n\n");
                  page = pageString(summary, offset, limit);
                  size = page.total;
                } else {
                  const stat = await gitPage(cwd, [...options, "--stat=240,200", ...range, ...(path ? ["--", path] : [])], 0, 8192);
                  const summary = [stat.text.trimEnd(), formatOmittedGenerated(generated)].filter(Boolean).join("\n\n");
                  page = pageString(summary, offset, limit);
                  size = page.total;
                }
              } else {
                const hasGeneratedAncestor = generated.some((g) => regular.some((r) => r.path.startsWith(`${g.path}/`)));
                const useExcludes = !hasGeneratedAncestor && generated.length < regular.length;
                const specs = useExcludes
                  ? [...(path ? [`:(literal)${path}`] : []), ...generated.map((entry) => `:(exclude,literal)${entry.path}`)]
                  : regular.map((entry) => entry.path);
                const argBytes = specs.reduce((sum, spec) => sum + Buffer.byteLength(spec, "utf8") + 1, 0);
                if (argBytes <= 128 * 1024) {
                  const diffArgs = [...(useExcludes ? baseDiffOptions : options), ...range, "--", ...specs];
                  const prefix = `${formatOmittedGenerated(generated)}\n\n`;
                  const prefixBytes = Buffer.byteLength(prefix, "utf8");
                  if (offset < prefixBytes) {
                    const headPage = pageString(prefix, offset, limit);
                    const rem = limit - Buffer.byteLength(headPage.text, "utf8");
                    if (headPage.more) {
                      page = { text: headPage.text, end: headPage.end, more: true };
                    } else if (rem > 0) {
                      const diffPage = await gitPage(cwd, diffArgs, 0, rem);
                      page = {
                        text: headPage.text + diffPage.text,
                        end: prefixBytes + diffPage.end,
                        more: diffPage.more,
                        ...(diffPage.total !== undefined ? { total: prefixBytes + diffPage.total } : {}),
                      };
                    } else {
                      const probe = await gitPage(cwd, diffArgs, 0, 1);
                      page = { text: headPage.text, end: prefixBytes, more: Boolean(probe.text), ...(probe.total !== undefined ? { total: prefixBytes + probe.total } : {}) };
                    }
                  } else {
                    const diffPage = await gitPage(cwd, diffArgs, offset - prefixBytes, limit);
                    page = {
                      text: diffPage.text,
                      end: prefixBytes + diffPage.end,
                      more: diffPage.more,
                      ...(diffPage.total !== undefined ? { total: prefixBytes + diffPage.total } : {}),
                    };
                  }
                  size = page.total;
                }
              }
            }
          }
        }
        if (!page) {
          page = await gitPage(cwd, [...options, ...(operation === "diff_stat" ? ["--stat=240,200"] : []), ...range, ...(path ? ["--", path] : [])], offset, limit);
        }
        // Inspecting base-branch drift or merged/rebased deltas must not pull unrelated main files into review scope.
        const prReview = Boolean(revisions.base && revisions.head && (revisions.head !== revisions.main || revisions.previousHead));
        const prDiff = Boolean(revisions.base && revisions.head) && range.every((sha) => sha === revisions.base || sha === revisions.head);
        const pureBaseDrift = Boolean(revisions.main) && (
          Boolean(revisions.previousMain) && range.every((sha) => sha === revisions.previousMain || sha === revisions.main)
          || prReview && !prDiff && range.every((sha) => sha === revisions.base || sha === revisions.previousMain || sha === revisions.main)
        );
        const mergedDelta = !pureBaseDrift && !prDiff && prReview && range.some((sha) =>
          sha === revisions.previousHead || sha === revisions.previousMain || (sha === revisions.main && revisions.main !== revisions.base));
        if (mergedDelta) {
          if (path && path !== ".") {
            const names = await gitPage(cwd, [...options, "--name-only", "-z", ...range, "--", path], 0, Buffer.byteLength(path) + 2);
            if (!names.more && names.text === `${path}\0`) scope.push(path);
          }
        } else if (!pureBaseDrift) {
          const names = await gitPage(cwd, [...options, "--name-only", "-z", ...range, ...(path ? ["--", path] : [])], 0, config.tools.git.maxScopeBytes);
          const entries = names.text.split("\0");
          if (names.more) {
            entries.pop();
            log?.warn({ event: "review_git.scope_truncated", operation, from, to, path, maxScopeBytes: config.tools.git.maxScopeBytes }, "Git diff scope exceeded maxScopeBytes; remaining paths omitted");
          }
          scope.push(...entries.filter(Boolean));
        }
      } else if (operation === "log") {
        const end = await resolveRevision(revision ?? "head", "revision", operation);
        page = await gitPage(cwd, ["--literal-pathspecs", "log", "--no-color", "--no-decorate", `--max-count=${config.tools.git.maxCommits}`,
          "--format=%H %cs %an: %s", end, ...(path ? ["--", path] : [])], offset, limit);
        if (path && path !== ".") scope.push(path);
      } else {
        const object = `${await resolveRevision(revision, "revision", operation)}:${path}`;
        page = await gitPage(cwd, ["show", object], offset, limit);
        if (page.more) size = await blobSize(cwd, object);
        if (path && path !== ".") scope.push(path);
      }
      for (const entry of scope) touched.add(entry);
      if (operation !== "show" && !page.more) page = { ...page, text: page.text.trimEnd() };
      const text = pageText(page, offset, size);
      return { content: [{ type: "text", text: text || "(no output)" }], details: { operation, offset, bytes: page.end } };
    },
  });
}
