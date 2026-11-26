import type { WorkflowContext } from "../../src/workflow-ctx.ts";

type ProposalResult = {
  status: "complete" | "incomplete" | "needs_decision";
  found: boolean;
  slug?: string;
  title?: string;
  linkedNumbers?: number[];
  summary?: string;
  evidence?: Array<{ path: string; symbol?: string; detail: string }>;
  proposal?: string;
};

type CritiqueResult = {
  status: "complete" | "incomplete" | "needs_decision";
  approved: boolean;
  reason: string;
  revisedTitle?: string;
  revisedBody?: string;
};

const proposeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["found"],
  if: {
    properties: { found: { const: true } },
    required: ["found"],
  },
  then: {
    required: ["slug", "title", "linkedNumbers", "proposal"],
  },
  properties: {
    found: { type: "boolean", description: "True only if one high-leverage primitive or refactor eliminates a verified shared root cause." },
    slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,60}$", description: "Short kebab-case slug for deduplication when found is true." },
    title: { type: "string", minLength: 5, description: "Concise GitHub RFC issue title when found is true." },
    linkedNumbers: { type: "array", items: { type: "integer" }, description: "Issue/PR numbers whose shared root cause this addresses." },
    summary: { type: "string", description: "2-3 sentence summary of the shared root cause and proposed primitive." },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "detail"],
        properties: {
          path: { type: "string" },
          symbol: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
    proposal: { type: "string", minLength: 10, description: "Full Markdown RFC issue body when found is true." },
  },
};

const critiqueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "reason"],
  properties: {
    approved: { type: "boolean" },
    reason: { type: "string" },
    revisedTitle: { type: "string" },
    revisedBody: { type: "string" },
  },
};

type ProposedRfc = { slug: string; title: string; issueNumber?: number; proposedAt: string };

const str = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const strList = (value: unknown, fallback: string[]) => Array.isArray(value) && value.every((v) => typeof v === "string") ? value : fallback;
const trimBody = (text: string | null | undefined, max: number) => {
  const clean = (text ?? "").trim();
  if (clean.length <= max) return clean;
  return max ? `${clean.slice(0, max - 1)}…` : "";
};

export default async function maintainerSweep(ctx: WorkflowContext) {
  const cfg = ctx.workflow.config;
  const count = (key: string) => {
    const value = cfg[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`maintainer-sweep config.${key} must be a non-negative integer`);
    }
    return value;
  };
  const maxOpenIssues = count("maxOpenIssues");
  const maxOpenPrs = count("maxOpenPrs");
  const recentMergedDays = count("recentMergedDays");
  const maxMergedPrs = count("maxMergedPrs");
  const minLinkedIssues = count("minLinkedIssues");
  const maxIssueBodyChars = count("maxIssueBodyChars");
  const maxPrBodyChars = count("maxPrBodyChars");
  const maxProposedHistory = count("maxProposedHistory");
  const channel = str(cfg.channel).trim();
  const issueLabels = strList(cfg.issueLabels, ["maintainer-rfc"]);

  const gathered = await ctx.step("gather", { maxOpenIssues, maxOpenPrs, recentMergedDays, maxMergedPrs, maxIssueBodyChars, maxPrBodyChars }, async () => {
    const previouslyProposed = ctx.state.get<ProposedRfc[]>("proposed") ?? [];
    const { open, merged } = await ctx.parallel({
      open: () => ctx.github.listOpenItems(),
      merged: () => ctx.github.listRecentMergedPrs(recentMergedDays, maxMergedPrs),
    });
    return {
      previouslyProposed,
      backlog: {
        openIssues: open.issues.slice(0, maxOpenIssues).map((i) => ({
          number: i.number,
          title: i.title,
          labels: i.labels.map((l) => typeof l === "string" ? l : (l.name ?? "")).filter(Boolean),
          updatedAt: i.updated_at,
          body: trimBody(i.body, maxIssueBodyChars),
        })),
        openPrs: open.pullRequests.slice(0, maxOpenPrs).map((p) => ({
          number: p.number,
          title: p.title,
          labels: p.labels.map((l) => typeof l === "string" ? l : (l.name ?? "")).filter(Boolean),
          updatedAt: p.updated_at,
          body: trimBody(p.body, maxPrBodyChars),
        })),
        recentMergedPrs: merged.map((m) => ({
          number: m.number,
          title: m.title,
          labels: m.labels,
          mergedAt: m.mergedAt,
          body: trimBody(m.body, maxPrBodyChars),
        })),
      },
    };
  });
  const { backlog, previouslyProposed } = gathered;

  const backlogNumbers = new Set([...backlog.openIssues, ...backlog.openPrs, ...backlog.recentMergedPrs].map(({ number }) => number));
  if (backlogNumbers.size < minLinkedIssues) {
    return { status: "skipped", reason: "Not enough backlog items to cluster." };
  }

  return ctx.workspace.withCheckout(ctx.workspace.baseBranch, async (ws) => {
    const proposalRun = await ctx.step("propose", { baseSha: ws.baseSha, backlog, minLinkedIssues, previouslyProposed }, async () => {
      const res = await ctx.agent.run<ProposalResult>({
        cwd: ws.path,
        input: { ...backlog, minLinkedIssues, previouslyProposed },
        submitResult: {
          schema: proposeSchema,
          description: "Submit the maintainer sweep RFC decision (or found: false if no high-leverage shared root cause exists).",
        },
      });
      if (res.outcome !== "complete") throw new Error(`Propose agent did not complete (outcome: ${res.outcome})`);
      return res;
    });

    const proposal = proposalRun.data;
    if (!proposal?.found || !proposal.slug || !proposal.title || !proposal.proposal) {
      return { status: "no_rfc", summary: proposal?.summary ?? proposalRun.text };
    }
    const { slug } = proposal;
    const linked = [...new Set(proposal.linkedNumbers)].filter((number) => Number.isInteger(number) && backlogNumbers.has(number));
    if (linked.length < minLinkedIssues) {
      return { status: "rejected_threshold", slug, linkedNumbers: linked, minLinkedIssues };
    }
    if (previouslyProposed.some((entry) => entry.slug === slug)) {
      return { status: "already_proposed", slug };
    }

    const linkedSet = new Set(linked);
    const critiqueInput = {
      proposal: { ...proposal, linkedNumbers: linked },
      minLinkedIssues,
      previouslyProposed,
      linkedIssues: backlog.openIssues.filter(({ number }) => linkedSet.has(number)),
      linkedMergedPrs: backlog.recentMergedPrs.filter(({ number }) => linkedSet.has(number)),
      openPrs: backlog.openPrs,
    };
    const critiqueRun = await ctx.step("critique", { baseSha: ws.baseSha, ...critiqueInput }, async () => {
      const res = await ctx.agent.run<CritiqueResult>({
        cwd: ws.path,
        skill: "CRITIQUE.md",
        input: critiqueInput,
        submitResult: {
          schema: critiqueSchema,
          description: "Submit the skeptical maintainer verification verdict.",
        },
      });
      if (res.outcome !== "complete") throw new Error(`Critique agent did not complete (outcome: ${res.outcome})`);
      return res;
    });

    const critique = critiqueRun.data;
    if (!critique?.approved) {
      return { status: "critique_rejected", slug, reason: critique?.reason ?? critiqueRun.text };
    }

    const title = critique.revisedTitle?.trim() || proposal.title;
    const body = critique.revisedBody?.trim() || proposal.proposal;
    const key = `rfc-${slug}`;
    const issue = await ctx.github.issue({ key, title, body, labels: issueLabels });

    ctx.state.update<ProposedRfc[]>("proposed", (prev = []) => maxProposedHistory ? [
      ...prev.filter((entry) => entry.slug !== slug),
      { slug, title, issueNumber: issue.number || undefined, proposedAt: new Date().toISOString() },
    ].slice(-maxProposedHistory) : []);

    let slackResult: { ts: string; dryRun?: boolean; previewPath?: string } | undefined;
    if (channel) {
      const refLine = issue.dryRun ? `[dry-run] Would open RFC: ${title}` : issue.created ? `Opened RFC #${issue.number}: ${title}` : `RFC #${issue.number}: ${title}`;
      const text = `${refLine}\nLinked: ${linked.map((n) => `#${n}`).join(", ")}\n${proposal.summary ?? ""}`.trim();
      slackResult = await ctx.slack.post({ key, channel, text });
    }

    return {
      status: issue.dryRun ? "dry_run" : issue.created ? "opened" : "existing",
      slug,
      title,
      linkedNumbers: linked,
      issue,
      slack: slackResult,
    };
  });
}
