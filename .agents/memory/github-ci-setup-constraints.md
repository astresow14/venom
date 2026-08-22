---
name: GitHub CI setup constraints
description: Durable permission, test-isolation, and branch-protection rules for GitHub CI.
---

# GitHub CI identity and protection

## Test the current source of truth

Browser checks must run against the current workspace source rather than a mirror branch that may lag behind it.

**Why:** tests based on stale product code can fail for behavior that no longer exists.

**How to apply:** establish that the tested branch contains the current product changes before diagnosing or enforcing its result.

## A red required check may be a deliberate guard test

Before diagnosing CI infrastructure from a failed required check, read the diff
of the failing head commit. Verification branches in this repo intentionally add
an assertion that cannot pass (to prove the check blocks merges) and are then
closed unmerged, so the "only failing run" can be by design.

**Why:** the failure looks identical to a broken job in the run list, and
chasing it wastes a full diagnosis cycle on a working pipeline.

**How to apply:** list recent runs for the same workflow first — a later run
whose real test step succeeded on an ordinary branch proves the pipeline is
healthy — then confirm with the failing commit's patch before changing anything.

## Path-filter detection breaks on merge_group unless base/head are passed in

`dorny/paths-filter` only reads a base from the event payload for pull-request
events. On a `merge_group` event it falls back to the repository default branch
as base and `github.ref` as head — and a merge-queue checkout has no local
`main`, so the step fails outright with
`Could not determine what is main - fetch works but it's not a branch, tag or commit SHA`.
A failing detect job means the dependent required check never reports, which is
exactly how a queue entry gets stuck.

**Why:** the queue branch is the only ref `actions/checkout` fetches, and its
default depth of 1 leaves neither the base commit nor the base branch available.

**How to apply:** pass `base: merge_group.base_sha` and `ref: merge_group.head_sha`
(guarded by `github.event_name`, empty string otherwise — pull-request runs ignore
both inputs), and check out full history on merge-queue runs so no fetch-by-SHA is
needed. Note GitHub coerces bare `0` to false in expressions, so write the
event-conditional as `github.event_name == 'pull_request' && 1 || 0`; the
`&& '0' || '1'` shape is ambiguous.

**Verifiable without a queue:** run the action's published `dist/index.js` against
a synthetic repo with `GITHUB_EVENT_NAME=merge_group` and a hand-written event
payload. That reproduces the failure and proves the fix when GitHub's merge queue
cannot be enabled.

## Observe required-check identity before enforcing it

Create branch rules from the check name and provider identity reported by a successful run, not from a guessed workflow label.

**Why:** a required context that never matches a reported check can block every merge.

**How to apply:** let the workflow run once, inspect its check run, then configure and verify enforcement.

## Keep sync-health markers outside the tracked tree

Sync timestamps and health markers must be untracked operational state.

**Why:** a tracked marker changes on every sync and manufactures the drift it is meant to detect.

**How to apply:** store markers in ignored local state, and do not let marker-write failures fail the sync.

## Treat workflow writes as a separate capability

Routine repository write access does not imply permission to change CI workflows.

**Why:** GitHub can accept source commits from an identity while rejecting commits that change workflow definitions.

**How to apply:** classify the outgoing diff before choosing credentials, require explicit workflow-write capability, and never persist credentials in repository configuration.

## Keep path filtering inside required jobs

Keep a required workflow active and skip irrelevant work at the job level instead of filtering out the whole workflow.

**Why:** a job-level skip reports a conclusion, while a workflow that never starts may leave its required check pending.

**How to apply:** use an always-running detection job and condition expensive jobs on its output.

## Stub every backend read in browser checks

Browser suites that run without an API server must provide deterministic responses for every request made by a covered route.

**Why:** a local API can hide an undeclared test dependency that later breaks a hermetic CI run.

**How to apply:** audit route-level reads, stub them at the network boundary, and verify the suite without relying on a live backend.

## Merge queues do not exist on user-owned repositories

A queue can only be enabled on an organization-owned repository (public on any
plan; private needs Enterprise Cloud). On a user-owned repo the rulesets API
rejects the rule with `422 — Invalid rule 'merge_queue': ` and an **empty
reason after the colon**. That empty reason is availability gating, not a
parameter problem: the identical request with an ordinary rule type returns
201, and no merge_queue parameter variant changes the answer. Classic branch
protection has no queue field in the GraphQL schema, so there is no alternate
path — nobody can enable a queue on such a repo, API or UI.

**Why:** sequencing queue verification work on "admin rights + credentials"
wastes the whole plan when ownership, not permission, is the gate.

**How to apply:** probe availability first with a throwaway-branch ruleset
create (cheap, reversible, invisible to main); treat the empty-reason 422 as
"move to an org or drop the queue plan", and only then sequence credential and
workflow-sync work.

## The connector can administer rulesets it cannot push workflows for

The Replit GitHub connector's classic `repo` scope plus the owner's admin bit
covers the repository rulesets API (create/update/delete) and the GraphQL
merge-queue mutations, while still refusing `.github/workflows/**` pushes
(no `workflow` scope).

**Why:** branch-rule automation does not have to wait for the workflow-capable
credential; only workflow file content does.

**How to apply:** route ruleset and enforcement changes through the connector
credential; reserve the app/PAT for pushes that touch workflow files.

## Only a GitHub App avoids an expiring credential for workflow pushes

Pushing `.github/workflows/**` needs workflow write, which the connector will
never have. The two workable credentials are a **GitHub App installation token**
(minted per run from a private key that does not expire) or a fine-grained PAT
created with *No expiration*; anything else stalls CI changes when it lapses.

**Why:** GitHub Actions' own `GITHUB_TOKEN` cannot modify workflow files either,
so there is no in-CI escape hatch, and a short-lived PAT quietly turns "sync
failed" into unsynced CI config. The REST APIs are closed too: with a token
lacking workflow write, creating a blob succeeds and creating a *tree* that
places it under `.github/workflows/` fails with a bare `404`, so an unexplained
404 from the git data API is a permission answer, not a missing object.

**How to apply:** prefer the app. Read an installation token's capability from
the `permissions` object returned when it is minted — installation tokens cannot
call `/user`. A fine-grained PAT reports no `x-oauth-scopes` and has no cheap
probe for the workflows permission, so treat it as "maybe" and let the push be
the test; `/user` does return `github-authentication-token-expiration`, which is
enough to warn before a stored token lapses.

## A private-key fingerprint is not a GitHub App credential

`GITHUB_APP_ID` must be the numeric App ID and `GITHUB_APP_PRIVATE_KEY` must be
the complete PEM private-key file. A value formatted like `SHA256:...` is merely
the fingerprint GitHub displays beside a generated key, and cannot mint an
installation token.

**Why:** a fingerprint can be mistaken for the value to save, leaving workflow
changes indefinitely held back even though the app and its key appear to exist.

**How to apply:** validate the inputs before diagnosing repository permissions:
reject fingerprint-shaped values, confirm the App ID is numeric, then mint a
token and inspect its `permissions.workflows` value before attempting a sync.

## A fine-grained PAT with Workflows R/W unblocks `.github/workflows` pushes

When the GitHub App route stalls (users often paste the key's SHA256 fingerprint instead of the `.pem` contents), a fine-grained PAT is the fastest workflow-capable credential: repository access to the mirror plus Contents R/W, Pull requests R/W, Workflows R/W, saved as `GITHUB_TOKEN`. **Why:** the token is copy-paste from the browser — no file download to mishandle — and the sync resolver accepts it for workflow writes. **How to apply:** if a broken app credential still sits in env (e.g. a fingerprint-shaped key), the resolver stops on it by name rather than falling through — blank both app vars inline for the run (`GITHUB_APP_ID= GITHUB_APP_PRIVATE_KEY= pnpm run sync:github`) to force the token path.
