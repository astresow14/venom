---
name: Reassigned task may already be merged
description: Check git history for a prior session's merge before re-implementing an assigned task
---

A reassigned/in-progress task may have already been implemented and merged by an earlier interrupted session — task merges carry a `Replit-Task-Id` trailer and a descriptive commit message even when the task was never marked complete.

**Why:** A session can crash between the merge landing and task completion. Re-implementing from scratch wastes hours and risks conflicting with the merged code.

**How to apply:** Before writing code for an assigned task, run `git log -S "<distinctive identifier from the task>"` (or `--grep` on the task's theme) over the relevant files. If a matching merge exists, the remaining work is verification: typecheck the touched packages, re-run the feature's specs (intervening merges can break them — see stale-specs-after-merges and semantic-merge-route-mangling), fix drift, then complete.
