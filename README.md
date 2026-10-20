# Scrat

Scrat is a GitHub coding agent built with TypeScript, [Pi](https://github.com/earendil-works/pi), and SQLite. It reviews issues and pull requests, implements selected issues, and maintains its own PRs. Scrat handles scheduling, workspaces, validation, and publication; Pi investigates and writes code.

## How it works

GitHub sync turns repository state into a persistent task queue:

- **PR reviews:** two model sessions review independently. A fresh consolidation session combines their findings into one updatable comment and a grade label. This includes Scrat's own PRs.
- **Implementation and maintenance:** issues labelled `scrat` become implementation tasks. Conflicts and new external feedback on Scrat-authored PRs become separate repair tasks.
- **Issue reviews:** Scrat assesses issues and applies the `scrat` label when it considers them ready for implementation.

Concurrency, priorities, models, and reasoning levels come from configuration. Queued tasks coalesce by item and action; tasks sharing an item or workspace cannot execute together. Bot-authored comments do not trigger feedback tasks. A current review graded C, D or F on a Scrat PR queues one `address_review` repair per assessment (a queued repair is cancelled when its assessment goes stale or human feedback is pending), capped per PR by `maxSelfRepairs`.

Scrat serves the single configured repository and clone: sync and fetch refuse any other repository, a clone whose `origin` is a different repository is never updated (a clone whose origin is not a github.com URL for the configured repository, such as an ssh host alias, is refused), and queued tasks for items of another repository are rejected at claim.

GitHub access uses a repository-scoped client with shared, permission-specific authentication. Sync reads up to four issue discussions concurrently (issue metadata comes from the list response) and applies routing effects in order; each PR is observed once, inside its review lock, with its four reads in parallel, and that observation serves both routing and reconciliation. Startup sync still finishes before workers claim tasks. Credentials are cached; responses are revalidated, not trusted: reads send `If-None-Match` and GitHub's 304s (free against the rate limit) reuse the identical cached body, while publication and serialized PR reconciliation still fetch fresh state. When fewer than 10% of the hourly requests remain, sync defers its remaining item reads to the next interval (logged as `github.sync_deferred`, starting at a different item each sync); this also defers that PR's sync-driven reconciliation, but worker publication is never deferred. A rejected credential is refreshed on the next operation, without automatically replaying a failed write.

Implementations use isolated worktrees and branches; follow-ups reuse their workspace and Pi session. Checks must pass against the exact tree being committed before publication. Optional Docker PostgreSQL databases isolate mutating runs. PR closure triggers workspace cleanup; failed work is retained for recovery.

Stale branches are brought up to date by merge commit, never rebase. A Scrat PR that is behind its base and failed at preparation (or conflicts) gets a `resolve_conflicts` task: a clean merge is made in code without a model session and validated normally (a validation failure falls back to the agent in the same run), while conflicts go to the agent. Feedback and repair tasks on a behind Scrat PR whose preparation fails merge the base first and ship that merge with their own push. A human-authored PR that cannot be prepared because it is behind, but merges cleanly, is reviewed on a local throwaway merge of its base (the diff stays relative to the base, nothing is pushed or commented); if the merge conflicts, the review fails and asks the author to update the branch.

Repository commands, Git hooks and Pi's Bash receive a minimal inherited environment, never Scrat's credentials. Pi's file tools stay inside the worktree and its run's context directory (`data/runs/<run-id>/`, holding the discussion and larger context outside the worktree). Prompts are small manifests with no patch bodies; read-only sessions inspect changes through a capped, scope-recording read-only `git` tool instead of Bash. Comments, PR bodies and commits that contain configured credentials are refused rather than published.

The newest complete PR assessment is authoritative. Context and observed source/dependency changes determine freshness—a relevance heuristic, not a full dependency graph. Stale assessments lose their grade and require a fresh review; older opinions never regain authority. Publication-only retries reuse saved results. Scrat does not automatically merge PRs.

## Configure and run

Requires Node.js **22.19+**, Git, and the tools used by the target repository's workspace commands. Docker is required when per-run databases are configured.

1. Run `npm ci`.
2. Edit `scrat.config.json`: GitHub repository/App installation, model provider, action skills, concurrency, and workspace preparation/validation commands.
3. Create an untracked `.env` containing `GITHUB_APP_PRIVATE_KEY` and `CODEX_LB_API_KEY`. Install the GitHub App on the target repository with the necessary contents, issues, and pull-request permissions.
4. Initialize the local schema and start the service:

   ```sh
   npm run db:push
   npm run serve
   ```

**Starting the service enables real GitHub writes and code execution.** Use one service process; do not overlap it with standalone `sync` or `work` processes. Shutdown drains active tasks before exiting.

Useful commands:

```sh
npm run fetch                    # Save GitHub state without routing tasks
npm run sync                     # Sync, queue tasks, and reconcile reviews/labels
npm run work                     # Drain runnable queued work, then exit
npm run retry -- <task-id>        # Repair a failed task, or resume publication
npm run retry -- <task-id> --validation-only  # Recheck saved code without Pi
npm run enqueue -- <action> <number|item-id>... [--priority N]  # Queue work for PR/issue numbers; sync never cancels it, even past routing guards (closing the item does)
npm run cleanup                  # Retry finished-run resource cleanup
npm run typecheck                # Strict TypeScript and Node type-erasure compatibility
npm run knip                     # Unused files, exports, and dependencies
npm test                         # Integration/E2E tests; PostgreSQL case needs Docker
```

When the final validation fails because a command exited nonzero (including preparation commands), the failure is sent back into the same Pi session, up to two rounds, before the run fails. Commands killed by a signal (an out-of-memory kill or a timeout), tree mutation, secret-scan and acceptance failures are not sent back and fail the run as before; use `--validation-only` for the infrastructure cases.

Change sessions are told to keep working notes in `.scrat/notes.md` inside their workspace, so plans and findings survive context compaction, retries and validation feedback. Scrat adds `/.scrat/` to the clone's shared Git exclude file, so the notes are never committed or published; they are removed with the workspace.

Normal retries rerun Pi for pre-publication failures, reusing the workspace/session so it can repair the problem. Publication-only retries reuse the saved validated result.

Use `--validation-only` for a transient validation failure after a mutating agent returned complete. It requires a saved checkpoint with unchanged task input, workspace identity, HEAD, source tree, merge state, GitHub context, and base SHA. Scrat skips Pi, creates a fresh disposable database when configured, reruns preparation/migrations and all checks, and still enforces action postconditions before publication. Ignored files are outside the source checkpoint; configured preparation must restore any required dependency/generated state. Changed or incomplete work requires a normal repair retry.

When upgrading an existing installation, run `npm run db:push` before starting the new code (the installer does this). Old run history is preserved, but runs without checkpoints cannot use validation-only retry. No validation is bypassed, and a failed validation is retried only through the in-session feedback above.

For project review, run `typecheck`, `knip`, and the integration/E2E tests after `npm ci` (including dev dependencies). TypeScript checks `src/` and the Drizzle config without emitting JavaScript. Knip includes the CLI, deployment-only recovery, and subprocess-driven test entrypoints; ordinary source modules remain eligible for unused-code detection. Review findings before removing code or adding exceptions.

## Configuration

`scrat.config.json` controls runtime behavior. Restart the service after changing it; action settings are captured when a run is claimed, and retries retain their saved settings.

### Harness and GitHub

| Setting | Purpose |
| --- | --- |
| `harness.maxConcurrency` | Maximum simultaneous tasks, not model sessions or test subprocesses. Each PR review starts two reviewer sessions within one task. Change-mode tasks run a database container and, at the end, the validation suite (bounded by `maxConcurrentValidations`), so size this to the host's memory. |
| `harness.maxConcurrentValidations` | Maximum `workspace.validate` runs at once (default 3, a positive integer). Further runs wait in a FIFO queue; preparation does not take a slot. |
| `harness.logLevel` | Pino log verbosity, such as `info` or `debug`. |
| `github.repository` | Target GitHub repository as `owner/repo`. |
| `github.repositoryPath` | Local repository clone; relative paths resolve from the config directory. `SCRAT_REPOSITORY_PATH` overrides it. |
| `github.baseBranch` | Default base branch for issues and implementations. Existing PRs use their own base branch. |
| `github.botLogin` | Scrat's GitHub identity, used to recognize its PRs/comments and exclude its own feedback. |
| `github.appId` | GitHub App ID used for authentication. |
| `github.installationId` | App installation granting access to the target repository. |
| `github.fetchIntervalSeconds` | Delay between service syncs, in seconds. The service also syncs on startup. |

### Workspace

Workspace commands are argument arrays, not shell strings: `["pnpm", "verify"]`. Command lists execute sequentially inside the worktree; a failing command stops the run.

| Setting | Purpose |
| --- | --- |
| `workspace.environment` | Environment variables added to Pi's Bash commands and harness preparation/validation commands. These commands inherit only path, home, user, locale, temporary-directory, proxy, certificate and `DOCKER_HOST` settings, so any other variable they need belongs here. Test-process limits belong here too; task concurrency does not serialize tests. |
| `workspace.prepare` | Setup commands, including dependency installation and code generation. Also used for read-only reviews, and rerun before mutating-work validation. |
| `workspace.blockedCommands` | Optional regular expressions, matched against each shell command segment of Pi's Bash tool, with quoted text ignored and whitespace collapsed (leading `VAR=value`, `env`, `nohup`, `time`, `sudo`, `exec` and `timeout N` are stripped). A match is refused with a message telling the agent that Scrat runs the heavy check itself. This is a speed bump against accidental parallel lint/type-check/verify runs, not a sandbox: `sh -c '...'` or a script can still evade it. |
| `workspace.validate` | Required checks for mutating tasks before committing or publishing. Not run as a harness gate for read-only reviews. |
| `workspace.database` | Optional per-run PostgreSQL container configuration for mutating tasks; omit or set to `null` to disable. |
| `workspace.database.image` | PostgreSQL-compatible Docker image to start. |
| `workspace.database.environment` | Variable names populated with the temporary database URL, overriding corresponding workspace environment values. |
| `workspace.database.migrate` | Migration command run against the temporary database before validation. |

### Model providers

Each `providers.<name>` entry registers an endpoint and models with Pi. Actions refer to the provider by that name.

| Setting | Purpose |
| --- | --- |
| `baseUrl` | Provider or proxy API endpoint. |
| `api` | Pi API adapter, such as `openai-responses`. |
| `apiKey` | Credential; use environment interpolation such as `${CODEX_LB_API_KEY}` rather than committing a secret. |
| `authHeader` | Whether Pi supplies the API key in the Authorization header. |
| `models` | Models available through this provider. |
| `models[].id` / `name` | API model identifier / optional display name. Actions select the identifier. |
| `models[].reasoning` | Whether the model supports reasoning. |
| `models[].thinkingLevelMap` | Optional mapping from Pi thinking levels to provider-specific reasoning values. |
| `models[].contextWindow` | Declared context capacity in tokens. |
| `models[].maxTokens` | Model output-token limit used by Pi. |

### Actions

`actions` defines `review_issue`, `review_pr`, `implement`, `resolve_conflicts`, `address_pr_feedback`, and `address_review`.
Execution mode, acceptance rules, and publication behavior live in `src/actions.ts`; configuration selects prompts, models, and priorities without changing those safety contracts.

| Setting under `actions.<action>` | Purpose |
| --- | --- |
| `priority` | Default queue priority; higher values are claimed first. Manual enqueue can override it. Running tasks are not preempted. |
| `skill` | Prompt file, resolved relative to the config directory. |
| `provider` / `model` | Provider name and model ID for the action. For PR reviews, these select the consolidator. |
| `thinkingLevel` | Requested Pi reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; provider/model support determines its mapping. |
| `reviewers` | PR review panel: exactly two entries, each with its own `provider`, `model`, and `thinkingLevel`. |
| `maxSelfRepairs` | `address_review` only: most self-repair tasks queued for one PR (non-negative integer, default 2; 0 disables self-repair; not enqueueable manually). A push makes the review stale and Scrat re-reviews; a reply-only repair is not retriggered for the same assessment. |

The checked-in configuration currently uses six task slots and three validation slots (sized for a 24 GB host, with the service capped at `MemoryMax=20G`), priorities **PR 100 > implementation/maintenance 60 > issue 10**, and a Sol-high/DeepSeek-high review panel with Sol-high consolidation. These are configurable values, not built-in limits or model choices.

## Project layout

- `src/github-tasks.ts` — GitHub observations, queue effects, and closure cleanup.
- `src/github.ts`, `src/github-types.ts` — repository client, scoped authentication, and narrow issue/PR views; raw sync snapshots remain in SQLite and `tmp/responses/github/` for diagnostics.
- `src/github-context.ts` — pure shared comment filtering and context revisions for routing, execution, and freshness checks.
- `src/actions.ts` — typed execution, acceptance, and publication contracts; workspace lifetime follows action mode.
- `src/github-routing.ts` — pure issue-selection, PR-maintenance, and review-routing decisions.
- `src/tasks.ts`, `src/runner.ts` — atomic claims and task/run lifecycle.
- `src/pi.ts`, `src/pr-review.ts` — Pi sessions and dual-model reviews.
- `src/pr-assessment.ts`, `src/pr-review-publication.ts` — assessment authority, freshness, and canonical delivery.
- `src/workspaces.ts`, `src/databases.ts` — Git and database resource lifecycles.
- `src/secrets.ts` — child-process environment and credential checks before publication.
- `skills/` — action prompts; `scrat.config.json` selects their models and settings.
- `data/` — SQLite queue, run history, event journal, workspaces, and Pi sessions. Back it up alongside credentials before deployment.

`deploy/install.sh` installs a staged release on the existing worker: it drains the service, backs up SQLite, applies schema updates, and switches to the selected release. It contains host-specific paths, so review it before reuse.
