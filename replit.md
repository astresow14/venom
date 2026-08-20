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
- `pnpm run sync:github` — push the current commit to the `replit-sync` branch and open (or refresh) a pull request against `main`. Add `-- --dry-run` to preview.
- `scripts/post-merge.sh` runs the same command after every task merge, so the mirror stays current without anyone remembering to push. Set `VENOM_SKIP_GITHUB_SYNC=1` to opt out of one run; a sync failure warns but never fails setup.
- Credentials come from the Replit GitHub connector, which refreshes its own OAuth token. No personal access token is pasted or stored, and the token is passed to git in memory only (`http.extraheader`), never written to `.git/config`.
- `main` is protected by a ruleset with no bypass actors: direct pushes are refused by design. Merging always happens through the pull request, once the `Kanban browser regression` check reports success.
- The connector's OAuth token has no `workflow` scope, so it cannot push changes under `.github/workflows/`. The sync stops with an explanation when a change touches those files; push them with a short-lived fine-grained token in `GITHUB_TOKEN` that has *Workflows: Read and write*.

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
- `lib/api-spec/openapi.yaml` — source of truth for the Venom API contract
- `artifacts/venom/constants/colors.ts` — mobile design tokens

## Architecture decisions

- The first release persists projects and conversation history on-device with AsyncStorage.
- AI responses stream through the shared API server using Replit's managed OpenAI integration.
- Public websites can be connected by signed-in users. The deployment's GitHub connector is a shared workspace credential and is available only to Clerk users listed in `VENOM_GITHUB_MEMBER_IDS`.

## Product

- Live AI chat with project context
- On-device conversation and project management
- Interactive visual ontology of knowledge clusters and their relationships
- Connection-readiness and model settings surface

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
