# Venom

A mobile-first AI intelligence workspace combining live chat, local projects, and visual knowledge clusters.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/venom run dev` — run the Expo mobile app through its managed workflow
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
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
- `artifacts/venom/constants/colors.ts` — mobile design tokens

## Architecture decisions

- The first release persists projects and conversation history on-device with AsyncStorage.
- The knowledge graph (concepts, links, evidence) is a server-side, owner-scoped ontology database — the system of record. Workspace snapshots no longer carry clusters: the server strips them on save, absorbs changes after the revision check passes, and injects the freshest concepts back into every snapshot response, so devices keep working offline from that copy.
- Chat extraction files insights into the ontology store server-side; clients apply the returned `filed` records and fall back to local filing if the server omits them. Brain search on both clients queries the whole ontology across projects (`/api/venom/ontology/search`).
- AI responses stream through the shared API server from four providers — OpenAI, Anthropic, Gemini, and OpenRouter — via managed Replit AI integrations, with direct provider keys as a deliberate fallback. The server owns the sanitized model catalog and one streaming adapter per provider; clients speak Venom-branded aliases only. See Product thesis.
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

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
