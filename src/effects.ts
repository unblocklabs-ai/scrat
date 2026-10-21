import { eq } from "drizzle-orm";
import { actionContracts } from "./actions.ts";
import { postCommitReply } from "./commit-review.ts";
import { upsertComment } from "./comments.ts";
import { db } from "./db.ts";
import type { EventReferences } from "./events.ts";
import { branchContainsCommit } from "./git.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubContext } from "./github-types.ts";
import { botSlug } from "./identity.ts";
import { upsertItem } from "./items.ts";
import { reconcileLabels } from "./labels.ts";
import { isIssueComment, taskMarker } from "./markers.ts";
import { observe } from "./observation.ts";
import { reconcilePrReview } from "./pr-review-publication.ts";
import { remoteUrl } from "./repository.ts";
import { items, runs, tasks } from "./schema.ts";
import { getWorkspace, pushWorkspace } from "./workspaces.ts";

type Run = typeof runs.$inferSelect;
type Receipts = Run["publication"];
type Evaluated = Run & { result: NonNullable<Run["result"]>; context: NonNullable<Run["context"]> };

export type EffectContext = {
  references: EventReferences;
  publication: () => Receipts;
  saveReceipt: (patch: Partial<Receipts>, database?: Pick<typeof db, "update">) => void;
};

type GithubEffectContext = EffectContext & {
  github: GitHubRepository;
  task: typeof tasks.$inferSelect;
  run: Evaluated;
  current: GithubContext;
  workspace?: NonNullable<ReturnType<typeof getWorkspace>>;
  commitSha?: string;
};

type SlackEffectContext = EffectContext & {
  item: typeof items.$inferSelect;
  run: Run;
};

type Effect<Context extends EffectContext> = {
  receipted?: (publication: Receipts, context: Context) => boolean;
  settlesRun?: boolean;
  apply: (context: Context) => Promise<void>;
};

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
    if (!await branchContainsCommit(workspace.repositoryPath, remote, workspace.branch, commitSha, env)) {
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
      title: `fix: ${evaluated.item.title}`, body: `${result.text}\n\nCloses #${evaluated.item.number}\n\n${taskMarker(task.id)}`,
      head: workspace.branch, base: evaluated.baseBranch,
    }, references);
    const publishedPr = pr;
    db.transaction((transaction) => {
      const created = upsertItem({ source: "github", externalId: publishedPr.node_id, kind: "pr", payload: publishedPr }, transaction);
      transaction.update(items).set({ workspaceId: workspace.id }).where(eq(items.id, created.id)).run();
      context.saveReceipt({ pullRequestNumber: publishedPr.number }, transaction);
    });
  },
} satisfies Effect<GithubEffectContext>;

const comment = {
  receipted: (publication) => Boolean(publication.commentId),
  async apply({ github, task, run, current, references, saveReceipt }) {
    const marker = taskMarker(task.id);
    const observation = observe(github.repository, current);
    const existing = observation.own.findLast((candidate) => isIssueComment(candidate) && candidate.body.trimEnd().endsWith(marker));
    const commentId = await upsertComment(github, run.context.item.number, existing, `${run.result.text}\n\n${marker}`, references);
    saveReceipt({ commentId });
  },
} satisfies Effect<GithubEffectContext>;

const labels = {
  async apply({ github, run, current, references, saveReceipt }) {
    const observation = observe(github.repository, current);
    await reconcileLabels(github, run.context.item.number, {
      current: observation.labels, desired: run.result.ready ? [botSlug] : [], managed: [botSlug],
    }, references);
    saveReceipt({ scratLabel: run.result.ready });
  },
} satisfies Effect<GithubEffectContext>;

const prAssessment = {
  settlesRun: true,
  apply: ({ github, task, run, references }) =>
    reconcilePrReview(github, task.itemId, run.context.item.number, references, { task, run }),
} satisfies Effect<GithubEffectContext>;

const slackReply = {
  receipted: (publication) => Boolean(publication.slackReplyTs),
  async apply({ item, run, saveReceipt }) {
    saveReceipt({ slackReplyTs: await postCommitReply(item, run) });
  },
} satisfies Effect<SlackEffectContext>;

const effects = { push, pull_request: pullRequest, comment, labels, pr_assessment: prAssessment, slack_reply: slackReply };

const publicationEffects = {
  "pull-request": [effects.push, effects.pull_request],
  comment: [effects.push, effects.comment],
  "issue-assessment": [effects.comment, effects.labels],
  "pr-assessment": [effects.pr_assessment],
  "slack-thread": [effects.slack_reply],
} as const satisfies Record<typeof actionContracts[keyof typeof actionContracts]["publication"], readonly Effect<never>[]>;

export type PublicationKind = keyof typeof publicationEffects;

export async function applyEffects<Context extends EffectContext>(kind: PublicationKind, context: Context) {
  const list = publicationEffects[kind] as unknown as readonly Effect<Context>[];
  for (const effect of list) {
    if (!effect.receipted?.(context.publication(), context)) await effect.apply(context);
  }
  if (!list.some((effect) => effect.settlesRun)) context.saveReceipt({ status: "published" });
}
