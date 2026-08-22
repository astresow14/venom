---
name: CI paths-filter dependency coverage
description: Required GitHub checks that skip via dorny/paths-filter must list every workspace lib the app depends on, in lockstep with package.json.
---

# CI paths filters mirror workspace deps

Each per-app GitHub workflow (api-server tests, desktop e2e, kanban e2e) gates its suite behind a dorny/paths-filter `changes` job. A skipped required check counts as passing, so any path missing from the filter is a merge-without-testing hole.

**Rule:** an app's filter must list the app dir, every `workspace:` dependency's lib dir (plus `lib/api-spec/**` because the generated client derives from it), the root manifests (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`), and the workflow file itself.

**Why:** both Venom apps gained `@workspace/slime`, `@workspace/knowledge-text`, and `@workspace/venom-workspace-merge` while the e2e filters still listed only the api-client libs — a slime-only PR reported both browser suites "skipped" and could merge broken.

**How to apply:** whenever a `workspace:` dep is added to (or removed from) an artifact's package.json, update that app's filter block in the matching `.github/workflows/*.yml` in the same change. Nothing enforces this automatically today.
