---
name: GitHub CI setup constraints
description: Why the Replit GitHub connector cannot configure CI, and what a token/ruleset setup actually needs to succeed.
---

# Writing CI config to GitHub from this workspace

## The connector cannot create or update workflow files

The Replit GitHub connector authenticates fine and writes ordinary files, but it
cannot be used to install or change anything under `.github/workflows`:

- Any request whose **path contains `.github/workflows`** is rejected by an edge
  proxy with a **403 HTML page** — not a GitHub JSON error. Single- and
  double-URL-encoding the path does not evade it.
- The connector's OAuth token lacks GitHub's **`workflow`** scope, so GraphQL
  `createCommitOnBranch` refuses workflow-file commits with a misleading
  "does not have the correct permissions" message.
- Git **tree creation** (`POST /git/trees`) returns 404 through the connector
  even though `POST /git/blobs` succeeds, so building a commit server-side is
  not a workaround.
- The connector proxy throttles at roughly **10 requests/sec** (429s on parallel
  file uploads), so file-by-file imports are slow and abort partway.

**Why:** these are proxy/scope limits outside GitHub, so they cannot be fixed by
reauthorizing the connection.

**How to apply:** for CI work (workflow files, Actions secrets, rulesets), ask
the user for a temporary **fine-grained PAT** scoped to the one repository with
**Contents**, **Workflows**, **Administration**, and **Secrets** at
*Read and write*. Push with the token held only in process memory via
`GIT_CONFIG_COUNT` + `http.extraheader`, never written to `.git/config` or echoed.

## Diagnose permission failures from the response header, not by guessing

A fine-grained PAT returns `403 "Resource not accessible by personal access token"`
for every missing permission, but the response header
**`x-accepted-github-permissions`** names the exact one (e.g. `contents=write`).

**Why:** the 403 body is identical regardless of which permission is missing, and
a repo the token cannot see at all returns 404 instead — so a 403 plus that
header proves repo access is fine and isolates the single missing toggle.

**How to apply:** probe with one cheap write (creating a loose blob is harmless
and unreferenced), read the header, and tell the user the one row to change
rather than asking them to re-check the whole permission list.

## Rulesets require a public repo on GitHub Free

Branch rulesets and protected branches are unavailable on private repositories
for Free accounts. Making a repo public to gain them is a **user decision** —
confirm explicitly, and audit tracked files for secrets before publishing.

## Required status check context is the job name

A ruleset's `required_status_checks[].context` must be the **job's** name
(e.g. `Kanban browser regression`), even though GitHub's UI displays it as
`Workflow name / Job name`. Pair it with `integration_id: 15368` (GitHub Actions)
so an outside app cannot satisfy the requirement.

**Why:** a context string that never matches a reported check silently blocks
every pull request forever with "waiting for status to be reported".

**How to apply:** let the workflow run **once** first, read the real check-run
name and app id from `GET /commits/{sha}/check-runs`, and only then create the
ruleset. Verify enforcement by attempting the merge through the API — a genuine
block returns **405 "Repository rule violations found"**.

## Path-filter CI with a job-level `if:`, never workflow-level `paths:`

A required check that is filtered out at the **workflow** level never reports and
blocks unrelated pull requests permanently. A job skipped by an `if:` condition
still reports a `skipped` check run, which satisfies the requirement.

## Sealing Actions secrets in this container

PyNaCl is not available. Use `libsodium-wrappers` installed into a scratch
directory outside the repo, and run it from a **`.cjs` file** — a `require()`
plus top-level `await` inside a `node <<EOF` heredoc fails with
`ERR_AMBIGUOUS_MODULE_SYNTAX`.
