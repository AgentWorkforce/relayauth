<!-- prpm:snippet:start @agent-workforce/trail-snippet@1.1.2 -->
# Trail

Record your work as a trajectory for future agents and humans to follow.

## Usage

If `trail` is installed globally, run commands directly:
```bash
trail start "Task description"
```

If not globally installed, use npx to run from local installation:
```bash
npx trail start "Task description"
```

## When Starting Work

Start a trajectory when beginning a task:

```bash
trail start "Implement user authentication"
```

With external task reference:
```bash
trail start "Fix login bug" --task "ENG-123"
```

## Recording Decisions

Record key decisions as you work:

```bash
trail decision "Chose JWT over sessions" \
  --reasoning "Stateless scaling requirements"
```

For minor decisions, reasoning is optional:
```bash
trail decision "Used existing auth middleware"
```

**Record decisions when you:**
- Choose between alternatives
- Make architectural trade-offs
- Decide on an approach after investigation

## Recording Reflections

Periodically step back and synthesize progress:

```bash
trail reflect "Workers aligned on auth approach, API layer progressing well" \
  --confidence 0.8
```

With focal points and adjustments:
```bash
trail reflect "Frontend and backend duplicating validation logic" \
  --focal-points "duplication,ownership" \
  --adjustments "Reassigning validation to backend team" \
  --confidence 0.7
```

**Record reflections when you:**
- Have received several updates and need to synthesize the big picture
- Notice workers or tasks diverging from the plan
- Want to course-correct before continuing
- Are coordinating multiple agents and need to assess overall progress

Reflections differ from decisions: decisions record a specific choice,
reflections record a higher-level synthesis of what's happening and whether
the current approach is working.

## Completing Work

When done, complete with a retrospective:

```bash
trail complete --summary "Added JWT auth with refresh tokens" --confidence 0.85
```

After completing work, compact the finished trajectory or merged PR into a
durable summary. When the compacted summary is sufficient, discard the raw
source trajectories so `.trajectories/index.json` and list output stay focused:

```bash
trail compact --discard-sources
# or after a PR merge:
trail compact --pr 42 --discard-sources
```

`--discard-sources` removes the source trajectory JSON/Markdown/trace files and
updates the index. Use it after confirming the compacted artifact is the record
you want to keep.

**Confidence levels:**
- 0.9+ : High confidence, well-tested
- 0.7-0.9 : Good confidence, standard implementation
- 0.5-0.7 : Some uncertainty, edge cases possible
- <0.5 : Significant uncertainty, needs review

## Abandoning Work

If you need to stop without completing:

```bash
trail abandon --reason "Blocked by missing API credentials"
```

## Checking Status

View current trajectory:
```bash
trail status
```

## Listing and Viewing Trajectories

List all trajectories:
```bash
trail list
```

View a specific trajectory:
```bash
trail show <trajectory-id>
```

Export a trajectory (markdown, json, timeline, html):
```bash
trail export <trajectory-id> --format markdown
```

## Compacting Trajectories

After a PR merge, compact related trajectories into a single summary and prune
raw source trajectories when the summary should replace them:

```bash
trail compact --pr 42 --discard-sources
```

Compact by branch (finds trajectories with commits not in the specified base branch):
```bash
trail compact --branch main --discard-sources
```

Compact by specific commits:
```bash
trail compact --commits abc123,def456 --discard-sources
```

Compaction consolidates decisions and creates a grouped summary. Adding
`--discard-sources` makes the compacted artifact the durable record by removing
the raw trajectories and their index entries.

## Why Trail?

Your trajectory helps others understand:
- **What** you built (commits show this)
- **Why** you built it this way (trajectory shows this)
- **What alternatives** you considered
- **What challenges** you faced

Future agents can query past trajectories to learn from your decisions.
<!-- prpm:snippet:end @agent-workforce/trail-snippet@1.1.2 -->

# Repository Rules

## No Cloudflare dependencies in `@relayauth/*`

`@relayauth/*` is published OSS and must stay platform-agnostic. The server
runtime is pure Node.js + better-sqlite3, and the SDK/types packages are
runtime-neutral. Cloudflare-specific code was intentionally removed from this
repo in commit `7bfd40c` (refactor: remove Cloudflare deps from OSS) and must
not be reintroduced.

Rules for agents touching this repo:

- Do not import `cloudflare:workers`, `@cloudflare/workers-types`, D1, KV,
  Durable Object, or R2 types/APIs anywhere under `packages/`.
- Do not add `DurableObject`-extending classes, `D1Database` references, or
  KV/DO bindings to `AppEnv`/`AppConfig` or any published type.
- `packages/server/src/storage/` holds the pure interface contracts
  (`interface.ts`) and the Node/SQLite implementation (`sqlite.ts`). Adapters
  for Cloudflare primitives live in the **cloud** repo
  (`AgentWorkforce/cloud`, under `packages/relayauth/`), not here.
- If a consumer needs a Cloudflare-shaped adapter, extend the `@relayauth/*`
  interface here (typed in terms of plain Node APIs), publish, and implement
  the adapter in the cloud repo.
- Leftover `dist/durable-objects/` artifacts from before the OSS refactor
  should be scrubbed in any working tree — they are gitignored but can
  confuse local test runs and publishing if stale.

See also: `AgentWorkforce/cloud` → `AGENTS.md` "RelayAuth ↔ Cloud Separation"
for the mirror rule on the cloud side.

<!-- prpm:snippet:start @agent-relay/merge-train-snippet@1.0.2 -->
## Merging: `trunk` + the `mergeable` label

CI suites do **not** run automatically on feature branches. They run only on
this repository's `trunk` → `main` pull request and on pushes to `main`. The
one check that does run on a feature PR into `main` is `Trunk guard`, which
fails it on purpose; manually dispatched workflows (`workflow_dispatch`) still
run on any branch. (Repos whose default branch is not
`main`, e.g. `master`, use that branch wherever this says `main`.) A merge
agent batches ready PRs into `trunk`, gets that one PR green, and merges it.

**When you open a PR**
1. Branch from `trunk` and open the PR with **base `trunk`**, not `main`.
   A PR into `main` from any other branch fails the `Trunk guard` check.
2. No CI runs on your PR, so verify locally before calling it ready: run the
   typecheck, tests and lint this repo uses, and list the exact commands and
   results in the PR body.
3. If the repo has numbered migrations, re-derive the migration floor (the
   highest number on `trunk`) right before pushing. Renumber a migration? Push
   the renumbered branch immediately; an unpushed reservation is invisible to
   every check.

**When the PR is ready**
4. Add the label **`mergeable`** once all of these are true:
   - The change is complete and the local checks above pass.
   - Review feedback (human and bot) is addressed or answered.
   - It is not a draft and does not depend on an unmerged PR.
5. Remove `mergeable` if the PR stops being ready (new work, a failing check, a
   blocking question). The label is read live from GitHub on every sweep.

**What you must not do**
- Do not merge your own PR, and never merge into or push to `trunk` or `main`
  directly.
- Do not re-enable CI for feature branches or edit the `trunk` gates in
  `.github/workflows/`.
- Never add `mergeable` to a PR you did not author without a human
  maintainer's explicit approval.
- Never add `mergeable` to an external contributor's PR (anyone outside the
  org without write access, including fork PRs). Only a maintainer labels
  those, after reviewing the exact head: the merge train merges an external PR
  only with a maintainer's APPROVED review on its head and `mergeable` added by
  a maintainer after the last push.

**The merge agent** sweeps open `mergeable` PRs with base `trunk` about every
10 minutes. It reads each PR's linked sessions (the `Agent Relay sessions`
block in the PR body, then the session summary) for context, merges them into
`trunk`, opens or updates the `trunk` → `main` PR, fixes CI there, merges when
green, and posts a summary. If your PR conflicts with `trunk`, it may ask you
to rebase on `trunk`; do so and keep the label.
<!-- prpm:snippet:end @agent-relay/merge-train-snippet@1.0.2 -->
