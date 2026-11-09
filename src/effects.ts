import { eq } from "drizzle-orm";
import { manifestOf } from "./actions.ts";
import { postReply, reactToRoot, verdictReaction } from "./commit-review.ts";
import { upsertComment } from "./comments.ts";
import { db } from "./db.ts";
import type { EventReferences } from "./events.ts";
import { conventionalTitle, git, remoteBranchHead, shortSha, workflowPaths } from "./git.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubContext } from "./github-types.ts";
import { isBotLogin } from "./config.ts";
import { botSlug } from "./identity.ts";
import type { EffectName } from "./manifests.ts";
import { upsertItem } from "./items.ts";
import { reconcileLabels } from "./labels.ts";
import { categoriesFor, itemLabelKey } from "./item-labels.ts";
import { validateLabelSelections } from "./results.ts";
import { endsWithMarker, fingerprintMarker, isIssueComment, reviewMarker, taskMarker, withMarker } from "./markers.ts";
import { observe } from "./observation.ts";
import { reconcilePrReview } from "./pr-review-publication.ts";
import { remoteUrl } from "./repository.ts";
import { assertPublishable } from "./secrets.ts";
import { subjects, workspaces, type Run, type Task, type Subject } from "./schema.ts";
import { assertCurrentImplementation } from "./tasks.ts";
import { expectedBranchHead, getWorkspace, pushWorkspace } from "./workspaces.ts";

type Receipts = Run["publication"];
export type Evaluated = Run & { result: NonNullable<Run["result"]>; context: NonNullable<Run["context"]> };

export type EffectContext = {
  references: EventReferences;
  publication: () => Receipts;
  saveReceipt: (patch: Partial<Receipts>, database?: Pick<typeof db, "update">) => void;
  github: GitHubRepository;
  subject: Subject;
  task: Task;
  run: Evaluated;
  current?: GithubContext;
  workspace?: NonNullable<ReturnType<typeof getWorkspace>>;
  commitSha?: string;
};

type Effect = {
  receipted?: (publication: Receipts, context: EffectContext) => boolean;
  settlesRun?: boolean;
  apply: (context: EffectContext) => Promise<void>;
};

function validationLine({ verification }: Run) {
  const passed = verification?.commands.filter((check) => check.status === "passed").map((check) => check.name);
  return verification && passed?.length ? `Validated on ${shortSha(verification.headSha)}: ${passed.join(", ")} passed.\n\n` : "";
}

function observed({ current }: EffectContext) {
  if (!current) throw new Error("Publication has no GitHub item context");
  return observe(current);
}

function changed(context: EffectContext) {
  const { workspace, commitSha } = context;
  if (!workspace || !commitSha) throw new Error("Change publication has no workspace or validated commit");
  return { workspace, commitSha };
}

async function changesWorkflows(path: string, commit: string, base: string, previousHead?: string) {
  const candidateBase = await git(path, ["merge-base", base, commit]);
  const intentional = await workflowPaths(path, candidateBase, commit);
  if (!previousHead) return intentional.length > 0;
  const delta = await workflowPaths(path, previousHead, commit);
  if (!delta.length) return false;
  const previousBase = await git(path, ["merge-base", candidateBase, previousHead]);
  const inherited = await workflowPaths(path, previousBase, candidateBase);
  return delta.some((file) => !inherited.includes(file) || intentional.includes(file));
}

const push = {
  receipted: (publication, context) => publication.publishedCommitSha === context.commitSha,
  async apply(context) {
    const { github, references, run } = context;
    const { workspace, commitSha } = changed(context);
    const remote = remoteUrl(github.repository);
    const readEnv = await github.getGitEnvironment();
    const expected = expectedBranchHead(workspace, run.context.headSha);
    const actual = await remoteBranchHead(workspace.repositoryPath, remote, workspace.branch, readEnv);
    if (actual !== commitSha) {
      if (actual !== expected) throw new Error("Remote branch changed before push; original work was retained");
      const workflows = run.mainSha && await changesWorkflows(workspace.path, commitSha, run.mainSha, expected);
      const env = await github.getGitEnvironment(workflows ? "workflows" : true);
      await pushWorkspace(workspace, remote, commitSha, env, references);
    }
    db.transaction((transaction) => {
      transaction.update(workspaces).set({ pushedHeadSha: commitSha }).where(eq(workspaces.id, workspace.id)).run();
      context.saveReceipt({ publishedCommitSha: commitSha }, transaction);
    });
  },
} satisfies Effect;

const pullRequest = {
  receipted: (publication) => Boolean(publication.pullRequestNumber),
  async apply(context) {
    const { github, task, run, references } = context;
    const { workspace, commitSha } = changed(context);
    const { context: evaluated, result } = run;
    let pr = await github.findPullRequest(workspace.branch, evaluated.baseBranch);
    if (pr?.state === "closed") throw new Error("The workspace PR was already closed");
    if (!pr) {
      const remote = remoteUrl(github.repository);
      if (await remoteBranchHead(workspace.repositoryPath, remote, workspace.branch, await github.getGitEnvironment()) !== commitSha) {
        throw new Error("Remote branch changed before PR creation; original work was retained");
      }
      await assertCurrentImplementation(github, task, evaluated.item.number, evaluated.baseBranch, workspace.branch);
      pr = await github.createPullRequest({
        title: conventionalTitle(evaluated.item.title), body: `${result.text}\n\n${validationLine(run)}Closes #${evaluated.item.number}\n\n${taskMarker(task.id)}`,
        head: workspace.branch, base: evaluated.baseBranch,
      }, references);
    }
    const publishedPr = pr;
    db.transaction((transaction) => {
      const created = upsertItem({ externalId: publishedPr.node_id, kind: "pr", payload: publishedPr }, transaction);
      transaction.update(subjects).set({ workspaceId: workspace.id }).where(eq(subjects.id, created.id)).run();
      context.saveReceipt({ pullRequestNumber: publishedPr.number }, transaction);
    });
  },
} satisfies Effect;

const comment = {
  receipted: (publication) => Boolean(publication.commentId),
  async apply(context) {
    const { github, task, run, references, saveReceipt } = context;
    const marker = manifestOf(task.action).mode === "review" ? reviewMarker : taskMarker(task.id);
    const observation = observed(context);
    const existing = observation.own.findLast((candidate) => isIssueComment(candidate) && endsWithMarker(candidate.body, marker));
    const commentId = await upsertComment(github, run.context.item.number, existing, withMarker(`${run.result.text}\n\n${validationLine(run)}`, marker), references);
    saveReceipt({ commentId });
  },
} satisfies Effect;

const labels = {
  async apply(context) {
    const { github, run, references } = context;
    if (!run.result.ready) return;
    const observation = observed(context);
    await reconcileLabels(github, run.context.item.number, { current: observation.labels, desired: [botSlug], managed: [] }, references);
  },
} satisfies Effect;

const prAssessment = {
  settlesRun: true,
  apply: ({ github, task, run, references }) =>
    reconcilePrReview(github, task.subjectId, run.context.item.number, references, { task, run }),
} satisfies Effect;

const itemLabels = {
  async apply(context) {
    const { github, task, run, references } = context;
    const observation = observed(context);
    const categories = categoriesFor(manifestOf(task.action), observation.kind);
    if (run.context.labeling?.key !== itemLabelKey(observation.item, categories)) throw new Error("GitHub item changed or label policy changed; enqueue a fresh labeling task");
    validateLabelSelections(run.result.labels, categories);
    await reconcileLabels(github, run.context.item.number, {
      current: observation.labels,
      desired: run.result.labels.map(({ name }) => name),
      managed: categories.flatMap(({ choices }) => choices.map(({ name }) => name)),
    }, references);
  },
} satisfies Effect;

const issue = {
  async apply({ github, run, references, publication, saveReceipt }) {
    const reported = run.result.issues ?? [];
    for (const { title, body, fingerprint } of reported) assertPublishable(title, body, fingerprintMarker(fingerprint));
    const missing = reported.filter(({ fingerprint }) => publication().issues?.[fingerprint] === undefined);
    if (!missing.length) return;
    const { issues: open } = await github.fetchOpenItems();
    for (const { title, body, fingerprint } of missing) {
      if (publication().issues?.[fingerprint] !== undefined) continue;
      const marker = fingerprintMarker(fingerprint);
      const existing = open.find((candidate) => isBotLogin(candidate.user?.login) && endsWithMarker(candidate.body ?? "", marker));
      const number = existing?.number ?? (await github.createIssue({ title, body, fingerprint }, references)).number;
      saveReceipt({ issues: { ...publication().issues, [fingerprint]: number } });
    }
  },
} satisfies Effect;

const slackReply = {
  receipted: (publication, { run }) => Boolean(publication.slackReplyTs) && (!run.result.storefrontReview || Boolean(publication.storefrontReplyTs)) && publication.slackReaction === verdictReaction(run),
  async apply(context) {
    const { subject, task, run, publication, saveReceipt } = context, audit = subject.kind === "window";
    if (!publication().slackReplyTs && !audit) saveReceipt({ slackReplyTs: await postReply(subject, task.action, run) });
    if (run.result.storefrontReview && !publication().storefrontReplyTs) {
      const storefront = await import("./storefront-main.ts");
      await (audit ? storefront.publishAudit(context) : storefront.publishStorefront(context));
    }
    const name = verdictReaction(run);
    if (!name) return;
    await reactToRoot(subject, name);
    saveReceipt({ slackReaction: name });
  },
} satisfies Effect;

const siteMap = {
  apply: async (context) => (await import("./storefront-site.ts")).saveSiteMap(context),
} satisfies Effect;

const effects = { push, pull_request: pullRequest, comment, labels, item_labels: itemLabels, pr_assessment: prAssessment, issue, slack_reply: slackReply, site_map: siteMap } satisfies Record<EffectName, Effect>;

export async function applyEffects(names: readonly EffectName[], context: EffectContext) {
  const list: readonly Effect[] = names.map((name) => effects[name]);
  for (const effect of list) {
    if (!effect.receipted?.(context.publication(), context)) await effect.apply(context);
  }
  if (!list.some((effect) => effect.settlesRun)) context.saveReceipt({ status: "published" });
}
