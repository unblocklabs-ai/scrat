import { eq } from "drizzle-orm";
import { manifestOf } from "./actions.ts";
import { postCommitReply, reactToCommitRoot, verdictReaction } from "./commit-review.ts";
import { upsertComment } from "./comments.ts";
import { db } from "./db.ts";
import type { EventReferences } from "./events.ts";
import { branchContainsCommit, conventionalTitle } from "./git.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubContext } from "./github-types.ts";
import { isBotLogin } from "./config.ts";
import { botSlug } from "./identity.ts";
import type { EffectName } from "./manifests.ts";
import { upsertItem } from "./items.ts";
import { reconcileLabels } from "./labels.ts";
import { endsWithMarker, fingerprintMarker, isIssueComment, reviewMarker, taskMarker, withMarker } from "./markers.ts";
import { observe } from "./observation.ts";
import { reconcilePrReview } from "./pr-review-publication.ts";
import { remoteUrl } from "./repository.ts";
import { assertPublishable } from "./secrets.ts";
import { subjects, type Run, type Task, type Subject } from "./schema.ts";
import { getWorkspace, pushWorkspace } from "./workspaces.ts";

type Receipts = Run["publication"];
type Evaluated = Run & { result: NonNullable<Run["result"]>; context: NonNullable<Run["context"]> };

export type EffectContext = {
  references: EventReferences;
  publication: () => Receipts;
  saveReceipt: (patch: Partial<Receipts>, database?: Pick<typeof db, "update">) => void;
};

type GithubEffectContext = EffectContext & {
  github: GitHubRepository;
  task: Task;
  run: Evaluated;
  current: GithubContext;
  workspace?: NonNullable<ReturnType<typeof getWorkspace>>;
  commitSha?: string;
};

type SlackEffectContext = EffectContext & {
  subject: Subject;
  task: Task;
  run: Run;
};

type Effect<Context extends EffectContext> = {
  receipted?: (publication: Receipts, context: Context) => boolean;
  settlesRun?: boolean;
  apply: (context: Context) => Promise<void>;
};

function validationLine({ verification }: Run) {
  const passed = verification?.commands.filter((check) => check.status === "passed").map((check) => check.name);
  return verification && passed?.length ? `Validated on ${verification.headSha.slice(0, 7)}: ${passed.join(", ")} passed.\n\n` : "";
}

function changed(context: GithubEffectContext) {
  const { workspace, commitSha } = context;
  if (!workspace || !commitSha) throw new Error("Change publication has no workspace or validated commit");
  return { workspace, commitSha };
}

const push = {
  receipted: (publication, context) => publication.publishedCommitSha === context.commitSha,
  async apply(context) {
    const { github, references } = context;
    const { workspace, commitSha } = changed(context);
    const remote = remoteUrl(github.repository);
    const env = await github.getGitEnvironment(true);
    if (!await branchContainsCommit(workspace, remote, workspace.branch, commitSha, env)) {
      await pushWorkspace(workspace, remote, commitSha, env, references);
    }
    context.saveReceipt({ publishedCommitSha: commitSha });
  },
} satisfies Effect<GithubEffectContext>;

const pullRequest = {
  receipted: (publication) => Boolean(publication.pullRequestNumber),
  async apply(context) {
    const { github, task, run, references } = context;
    const { workspace } = changed(context);
    const { context: evaluated, result } = run;
    let pr = await github.findPullRequest(workspace.branch, evaluated.baseBranch);
    if (pr?.state === "closed") throw new Error("The workspace PR was already closed");
    pr ??= await github.createPullRequest({
      title: conventionalTitle(evaluated.item.title), body: `${result.text}\n\n${validationLine(run)}Closes #${evaluated.item.number}\n\n${taskMarker(task.id)}`,
      head: workspace.branch, base: evaluated.baseBranch,
    }, references);
    const publishedPr = pr;
    db.transaction((transaction) => {
      const created = upsertItem({ externalId: publishedPr.node_id, kind: "pr", payload: publishedPr }, transaction);
      transaction.update(subjects).set({ workspaceId: workspace.id }).where(eq(subjects.id, created.id)).run();
      context.saveReceipt({ pullRequestNumber: publishedPr.number }, transaction);
    });
  },
} satisfies Effect<GithubEffectContext>;

const comment = {
  receipted: (publication) => Boolean(publication.commentId),
  async apply({ github, task, run, current, references, saveReceipt }) {
    const marker = manifestOf(task.action).mode === "review" ? reviewMarker : taskMarker(task.id);
    const observation = observe(github.repository, current);
    const existing = observation.own.findLast((candidate) => isIssueComment(candidate) && endsWithMarker(candidate.body, marker));
    const commentId = await upsertComment(github, run.context.item.number, existing, withMarker(`${run.result.text}\n\n${validationLine(run)}`, marker), references);
    saveReceipt({ commentId });
  },
} satisfies Effect<GithubEffectContext>;

const labels = {
  async apply({ github, run, current, references }) {
    if (!run.result.ready) return;
    const observation = observe(github.repository, current);
    await reconcileLabels(github, run.context.item.number, { current: observation.labels, desired: [botSlug], managed: [] }, references);
  },
} satisfies Effect<GithubEffectContext>;

const prAssessment = {
  settlesRun: true,
  apply: ({ github, task, run, references }) =>
    reconcilePrReview(github, task.subjectId, run.context.item.number, references, { task, run }),
} satisfies Effect<GithubEffectContext>;

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
} satisfies Effect<GithubEffectContext>;

const slackReply = {
  receipted: (publication, { run }) => Boolean(publication.slackReplyTs) && publication.slackReaction === verdictReaction(run),
  async apply({ subject, task, run, publication, saveReceipt }) {
    if (!publication().slackReplyTs) saveReceipt({ slackReplyTs: await postCommitReply(subject, task.action, run) });
    const name = verdictReaction(run);
    if (!name) return;
    await reactToCommitRoot(subject, name);
    saveReceipt({ slackReaction: name });
  },
} satisfies Effect<SlackEffectContext>;

const effects = { push, pull_request: pullRequest, comment, labels, pr_assessment: prAssessment, issue, slack_reply: slackReply } satisfies Record<EffectName, Effect<never>>;

export async function applyEffects<Context extends EffectContext>(names: readonly EffectName[], context: Context) {
  const list = names.map((name) => effects[name]) as unknown as readonly Effect<Context>[];
  for (const effect of list) {
    if (!effect.receipted?.(context.publication(), context)) await effect.apply(context);
  }
  if (!list.some((effect) => effect.settlesRun)) context.saveReceipt({ status: "published" });
}
