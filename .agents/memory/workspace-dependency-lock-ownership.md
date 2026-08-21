---
name: Workspace dependency lock ownership
description: How root-scoped package callbacks interact with dependencies declared by a child package in this pnpm workspace.
---

Package-management callbacks run against the workspace root and do not target a specific child package importer. They can add or remove a root dependency without repairing the lockfile entry for a dependency declared only by a child package.

**Why:** A connector SDK was declared by the API package but recorded under the root lockfile importer. Removing the redundant root dependency left the child importer stale until the workspace lockfile was regenerated from all manifests.

**How to apply:** When a dependency belongs to a child workspace package, verify both its manifest and that package’s `pnpm-lock.yaml` importer. After correcting ownership, regenerate the workspace lockfile and prove `pnpm install --frozen-lockfile` succeeds.

## Install state can drift from the manifest between sessions

A dependency declared in a child package.json can be missing from `node_modules/.pnpm` when a session starts. Symptoms look like broken code — `tsc` "Cannot find module", Expo "Failed to resolve plugin" — and they reproduce on a clean `git stash`, which makes them look "pre-existing on main".

**Why:** "The error exists on main too" only rules out *your diff*; it says nothing about install state, which git does not track.

**How to apply:** Before treating a missing-module error as a code bug or a pre-existing defect, compare the manifest against `node_modules/.pnpm`. If the manifest declares the package, `pnpm install` at the workspace root is the fix.