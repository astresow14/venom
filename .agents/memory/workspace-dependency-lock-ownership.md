---
name: Workspace dependency lock ownership
description: How root-scoped package callbacks interact with dependencies declared by a child package in this pnpm workspace.
---

Package-management callbacks run against the workspace root and do not target a specific child package importer. They can add or remove a root dependency without repairing the lockfile entry for a dependency declared only by a child package.

**Why:** A connector SDK was declared by the API package but recorded under the root lockfile importer. Removing the redundant root dependency left the child importer stale until the workspace lockfile was regenerated from all manifests.

**How to apply:** When a dependency belongs to a child workspace package, verify both its manifest and that package’s `pnpm-lock.yaml` importer. After correcting ownership, regenerate the workspace lockfile and prove `pnpm install --frozen-lockfile` succeeds.