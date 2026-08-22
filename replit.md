# Venom

A mobile-first AI intelligence workspace combining live chat, local projects, and visual knowledge clusters.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/venom run dev` — run the Expo mobile app through its managed workflow
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/venom-desktop run check:bundle-budget` — build the desktop app and fail if the landing route's critical-path JS (entry + preloaded vendor chunks) exceeds `bundle-budget.json`; after deliberate growth, refresh with `update:bundle-budget` and commit the file
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/api-spec run check:freshness` — regenerate in a disposable worktree of HEAD (never touches your working tree), then fail if the committed generated clients (`lib/api-zod/src/generated`, `lib/api-client-react/src/generated`) drift from the spec or carry EOF whitespace; registered as the `codegen-freshness` validation gate. Fix by running codegen and committing — never hand-edit generated files
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Env: `VENOM_SUPER_ADMIN_BOOTSTRAP_EMAIL` — verified email the API server resolves **once** at boot to designate the first canon super admin by account id. Fail-closed: no in-code default; when unset, bootstrap designates nobody and logs a non-PII skip. Provision it only through non-versioned secret configuration (workspace Secrets / deployment secrets) — never in `.replit` or any committed file. The dev database already holds the owner's durable designation (by account id), so the value is needed only when bootstrapping a fresh database. After bootstrap, the role is granted/revoked in-app on the super-admin-only Canon screens; the env var is never consulted per request.
- Required for the shared GitHub source connector: `VENOM_GITHUB_MEMBER_IDS` — comma-separated Clerk user IDs explicitly approved to use the workspace GitHub connection. This allowlist fails closed; update it whenever workspace membership changes.

## GitHub mirror

- Repository: https://github.com/astresow14/venom (default branch `main`)
- `pnpm run sync:github` — publish the current tree as a **snapshot commit** (the workspace tree rebuilt on the mirror's `main`), force-push it to the `replit-sync` branch, and open (or refresh) a pull request against `main`. Add `-- --dry-run` to preview.
- The mirror receives tree snapshots, never workspace history. Replit checkpoints commit whatever sits in the tree, so workspace history can carry things that must never publish (a private key once landed this way) and cannot safely be rewritten; snapshots also keep the pull request permanently mergeable, because its head is always built on the mirror's current `main`. Local commit ids therefore never appear on GitHub — the PR diff reads "make `main` equal the workspace tree".
- If the diff touches `.github/workflows/` and no credential can write workflow files, the sync pins those paths to `main`'s version for that run and says so (console, PR body, recorded state); the rest still ships. They follow automatically on the first sync after a workflow-capable credential is configured.
- `scripts/post-merge.sh` runs the same command after every task merge, so the mirror stays current without anyone remembering to push. Set `VENOM_SKIP_GITHUB_SYNC=1` to opt out of one run; a sync failure warns but never fails setup.
- `pnpm run check:github-sync` — report whether GitHub still carries the workspace tree: whether `main` matches (or matches except held-back workflow files), whether the sync pull request is stale or conflicting, and what the last recorded sync attempt did. Exit 0 in sync, 1 on drift, 2 when the check itself cannot run. Add `-- --quiet` to print only when something is wrong.
- Every sync run (success, failure, or skip) is recorded in `.local/state/venom/github-sync.json`, so a failure that scrolled past in a merge log is still visible later. The post-merge hook runs the check right after the sync, so a mirror that fell behind says so instead of going quiet.
- `main` is protected by a ruleset with no bypass actors: direct pushes are refused by design. Merging always happens through the pull request, once the required checks (`Kanban browser regression`, `Desktop workspace browser regression`) report success.
- `Kanban browser regression` runs the venom Playwright suite at **both** viewport sizes (`mobile-chromium` and `desktop-chromium`) in one job, with `timeout-minutes` in `.github/workflows/venom-kanban-e2e.yml` sized for the doubled pass. (While workflow files were held back for lack of a workflow-capable credential, that budget was stuck at 15 minutes and CI ran the phone-size pass only; the exclusion has been removed from `artifacts/venom/playwright.config.ts`.)
- The fast unit suites gate GitHub merges too: `Kanban browser regression` runs `@workspace/venom test:unit` and `Desktop workspace browser regression` runs `@workspace/venom-desktop test` as fail-fast steps before their browser passes, so a pure-logic break fails an already-required check. The sync tooling's suite (`@workspace/scripts test`) reports separately as `Scripts unit tests` from `.github/workflows/scripts-tests.yml`; to make that check required, add it by observed check identity after its first real run — never from a guessed label. Requiring it is deliberately deferred and tracked as follow-up task #371: the workflow file itself is held back from the mirror until a workflow-capable credential exists, and pre-registering a check that has never reported would leave every pull request stuck waiting on a context that never arrives.


### Merge queue (verified 2026-08-21)

- GitHub does not offer merge queues on repositories owned by a personal account, so nobody can enable one on `astresow14/venom` today — API or UI. Verified live against the repo: the rulesets API rejects a `merge_queue` rule (`422 — Invalid rule 'merge_queue'`) in every parameter variant while an otherwise identical ruleset with an ordinary rule is accepted, classic branch protection exposes no queue setting, and GitHub's docs scope queues to organization-owned repositories (public repos on any plan; private needs Enterprise Cloud). The only path is transferring the repository to an organization.
- If the repository ever moves to an organization, do **not** enable the queue until the `merge_group`-capable workflows are on the target default branch: `venom-kanban-e2e.yml` carries the fix locally but the GitHub copy predates it, and `venom-desktop-e2e.yml` still needs the same fix. A queue whose detect job fails on `merge_group` strands every entry until the check-response timeout — the exact failure this precaution exists to catch. After a transfer, also approve the Replit OAuth app under the organization's third-party access policy, or the connector loses API access to the repo.


### Key material never lives in the workspace

- GitHub App key material — the private key, and any other credential — belongs in a **Replit Secret** (`GITHUB_APP_PRIVATE_KEY`, read from the environment). Never upload a `.pem`, keystore, or `.env` file into the workspace: `attached_assets/` is tracked, and the sync mirrors it to a repository you do not control the copies of.
- `.gitignore` makes credential-shaped files untrackable by default (`*.pem`, `*.key`, `*.p12`, `*.p8`, `*.jks`, `*.keystore`, `id_rsa`-style SSH keys, `.env` files — `.env.example` and friends still track). Ordinary attachments such as screenshots and notes sync exactly as before.
- `pnpm run sync:github` refuses to push key material, and checks before it authenticates or contacts GitHub. It scans **every tracked file** — exactly the tree the snapshot publishes, since only snapshots ever ship and the sync refuses a dirty checkout first. A file is refused by extension or because it opens with a private key banner; the refusal names the path and never prints any contents. `scripts/src/lib/credential-guard.ts` holds the rules (including `scanHistoryForCredentials`, kept for any routine that would publish real history); its tests run offline with the other sync tests via `pnpm --filter @workspace/scripts run test`.
- **If a key file was uploaded anyway:** delete it from the workspace, then check whether it ever reached GitHub (`git log --all --name-only -- '<path>'`, and the mirror). Snapshot publishing keeps a key that was merely committed here from ever leaving the workspace, but a key that reached the mirror — even on an unmerged branch — must be regenerated at its provider. Store the replacement as a Replit Secret only.

### Sync credentials

The sync picks its credential automatically; nothing is pasted at run time. Every token is held in memory only, passed to git via `http.extraheader`, never written to `.git/config`, and redacted from output.

| Source                                                                                                     | Used for                                         | Expiry                                                                |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| Replit GitHub connector                                                                                    | every ordinary sync (default)                    | refreshes itself                                                      |
| GitHub App installation (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, optional `GITHUB_APP_INSTALLATION_ID`) | pushes that touch `.github/workflows/`           | token minted per run, valid one hour; the private key does not expire |
| `GITHUB_TOKEN`                                                                                             | workflow pushes when no GitHub App is configured | whatever the token was created with                                   |

The connector's OAuth token has no `workflow` scope, so a diff containing `.github/workflows/**` switches to the first credential that can write workflow files. If none can, the sync pins the workflow paths to `main`'s version and ships everything else (a diff that is *only* workflow files still stops with the setup steps below).

There is no way around that scope: with the connector token, a git push, the contents API and the low-level git data API all refuse a tree that touches `.github/workflows/` (the tree call answers `404`, not `403`). A workflow-capable credential has to come from the repository owner's GitHub account — one of the two setups below, configured once.

**Current state.** Neither is configured with a working value, so ordinary syncs run on the connector as usual, and a change under `.github/workflows/` stops the sync with these instructions instead of silently skipping. Filling in either setup below makes it work with no code change.

**Simplest setup (current).** A fine-grained token for `astresow14/venom` with repository permissions _Contents: Read and write_, _Pull requests: Read and write_, and _Workflows: Read and write_, created with **No expiration** and stored in the `GITHUB_TOKEN` secret. Nothing to rotate on a schedule — replace it only if it leaks or GitHub revokes it. If a token with an expiry date is used instead, the sync prints a warning on every run in the 14 days before it lapses, whether that token is running the whole sync or only the workflow push.

**Stronger option.** A GitHub App owned by the repo owner with the same three repository permissions, installed on `astresow14/venom`: store its app id in `GITHUB_APP_ID` and the downloaded `.pem` private key in `GITHUB_APP_PRIVATE_KEY` (raw PEM, escaped newlines, or base64 all work). The sync then mints a fresh one-hour installation token per run, so the stored secret is a private key rather than a token anyone could use directly. Rotate only if the key leaks: generate a new private key in the app settings, replace the secret, delete the old key.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/venom/` — Expo app, local workspace state, chat, projects, ontology, and settings
- `artifacts/api-server/src/routes/venom.ts` — streaming AI response service
- `artifacts/api-server/src/lib/venom-models.ts` — sanitized model catalog: Venom-branded aliases are public, provider model IDs are server-only
- `artifacts/api-server/src/lib/venom-provider-adapters.ts` — per-provider streaming adapters behind one normalized interface
- `artifacts/api-server/src/lib/venom-persona.ts` — bonded symbiote persona: prompt composition, host style profile schema, bond levels
- `artifacts/api-server/src/lib/venom-host-profile-store.ts` — per-account bond material counters, periodic profile refresh, Brain identity digest
- `lib/api-spec/openapi.yaml` — source of truth for the Venom API contract
- `artifacts/api-server/src/lib/venom-voice-restraint-tuning.md` — how to read the voice decision evidence endpoints (`/venom/voice/decisions/summary` and `/export`) against the restraint thresholds
- `lib/venom-workspace-merge/` — the one copy of the cross-device merge rules (deletion markers, tombstones, source/schedule merging); phone and desktop re-export it, and each app's `workspaceMergeRules.test.mjs` fails if either side stops using it. The API server's scheduled-source sync imports the deletion-marker rules from it too, with the same identity + fixture guards in `venom-scheduled-source-sync.test.ts`
- `lib/knowledge-text/` — the one copy of the citation display rules (the `[source:...]` marker grammar, segment parsing, archived-reference wording, plain-text flattening, `knowledgeDisplayText`); phone and desktop re-export it, and each app's `citationRules.test.mjs` fails if either side stops using it. The refresh/remap machinery stays phone-local in `artifacts/venom/context/messageCitations.ts`
- `artifacts/venom/constants/colors.ts` — mobile design tokens

## Architecture decisions

- The first release persists projects and conversation history on-device with AsyncStorage.
- The knowledge graph (concepts, links, evidence) is a server-side, owner-scoped ontology database — the system of record. Workspace snapshots no longer carry clusters: the server strips them on save, absorbs changes after the revision check passes, and injects the freshest concepts back into every snapshot response, so devices keep working offline from that copy.
- Chat extraction files insights into the ontology store server-side; clients apply the returned `filed` records and fall back to local filing if the server omits them. Brain search on both clients queries the whole ontology across projects (`/api/venom/ontology/search`).
- Knowledge has three tiers: personal Brains, company Brains (org-scoped), and the anonymous Venom master ontology. The master tier (`lib/venom-master-ontology.ts`, `routes/venom-master.ts`) learns only sanitized concept-level signals (normalized label, category, link pairs — never chat text, evidence, or identity) from tenants that opted in (per-user setting; per-company admin-controlled). A concept surfaces only once seen across ≥3 distinct tenants; opt-out removes the tenant's signals and rebuilds aggregates. It feeds back as a read-only third Brain layer ("Venom network"), dismissible suggestion chips on personal/company layers, and canonical vocabulary steering extraction (reference data in the prompt, never instructions).
- AI responses stream through the shared API server from four providers — OpenAI, Anthropic, Gemini, and OpenRouter — via managed Replit AI integrations, with direct provider keys as a deliberate fallback. The server owns the sanitized model catalog and one streaming adapter per provider; clients speak Venom-branded aliases only. See Product thesis.
- The direct Gemini credential is additionally gated by a server-side capability check (`verifyGeminiDirectCapability`, kicked off at boot): the catalog marks `venom-gemini` Ready only after the server confirms the credential can access the Gemini model catalog. The gate follows the client's credential precedence — a present direct key is always the one checked, even if the managed pair is also set; managed-only environments stay presence-based. The verdict is cached per process — a failed check stays Not configured until restart. `pnpm --filter @workspace/api-server run smoke:venom-providers` runs the same gate plus one live response per configured provider, printing safe verdicts only.
- Configured keys can still sit on accounts that cannot pay. Live calls report billing-class failures (credits exhausted, quota spent, payment required) into a per-process account-health overlay: the catalog keeps such a model `available` but says "Provider account issue" instead of "Ready" (`accountHealth: "unfunded"`), deliberation/debate planning stops auto-seating it, and chat returns a non-retryable `provider_account` error naming the account problem. The next successful stream — or a restart — clears the verdict, so topping up the account self-heals. Explicit user choices (active model, requested debate corners) are still honored with warnings, never silently rerouted.
- Venom's voice is a server-side bonded persona: a fixed directive symbiote posture plus a per-account style layer (derived periodically from the host's own messages, scaled by bond depth) and an identity digest of the strongest Brain concepts. All host-derived material is bounded, sanitized, and framed as descriptive data — it can change how answers sound, never facts, citations, or refusals. Composed only in `venom.ts`/`venom-persona.ts`, so mobile and desktop get it with zero client changes; there are deliberately no persona settings or UI.
- Public websites can be connected by signed-in users. The deployment's GitHub connector is a shared workspace credential and is available only to Clerk users listed in `VENOM_GITHUB_MEMBER_IDS`.

## Product thesis

Venom does not build AI — it rides the frontier labs' innovation through their APIs. The big providers keep improving their models with resources we can never match, and Venom inherits every improvement immediately and for free. Venom's own job is packaging: turning cutting-edge, harder-to-configure capability into a product consumers can just use. The differentiation is the packaging — bonded persona, knowledge ontology, product surface — never the model plumbing. Decision rules:

- **Buy the intelligence, build the product.** Never train, host, or rebuild model capability in-house. When a provider ships a new capability, prefer wrapping it into a simple Venom feature over building equivalent machinery ourselves.
- **A newer model is a server-side swap.** Upgrades edit the private alias→provider-model mapping in `artifacts/api-server/src/lib/venom-models.ts` behind the same Venom-branded alias (`venom-gpt`, `venom-claude`, `venom-gemini`, `venom-grok`). If a swap would need client changes, the abstraction has leaked — fix the leak, not the clients.
- **Provider plumbing never reaches consumers.** Raw provider model IDs, credentials, endpoints, and configuration stay server-side. Clients get the sanitized catalog only: Venom-branded names, plain-language summaries, ready/not-ready. Model lineage ("GPT", "Claude") is at most curated copy — never an ID to pick, a key to paste, or a setting to tune.
- **Stay portable across providers.** Each provider sits behind its own adapter in `artifacts/api-server/src/lib/venom-provider-adapters.ts`, taking Venom-normalized messages and translating internally, with errors normalized to provider-agnostic messages. Don't couple features to one provider's quirks in ways that would slow switching; a capability only one provider offers still gets a Venom-shaped interface so the dependency stays contained.

## Product

- Live AI chat with project context
- On-device conversation and project management
- Interactive visual ontology of knowledge clusters and their relationships
- Model choice across the Venom-branded catalog with connection readiness — no provider setup exposed

## User preferences

- (Aug 21, 2026) Prioritize ontology/knowledge-base structure and the visual UI experience first. Voice-agent work is planned but comes later — as do desktop meeting note-taker integrations (Zoom, Google Meet).
- (Aug 21, 2026) Chat file exchange is also a priority: users can upload files to the chatbot, and Venom can produce files for them (e.g. PDF). Design rule: a file-producing request does not run the multi-voice debate — exactly one model authors the file (the user's selected model, or a sensible default such as the venom-claude alias).

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
