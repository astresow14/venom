---
name: Untracked uploads still reach git history
description: Why deleting an untracked file is not enough in this workspace, and what to re-check after a merge.
---

# Untracked uploads still reach git history

Deleting an untracked file removes it from the working tree and produces **no diff**, so the
deletion cannot be carried by a commit. Meanwhile the workspace makes automatic checkpoint commits
(for example before a task merge) that use `git add --all`. If any branch still had the file on
disk at that moment, the checkpoint commits it, and it arrives on the shared branch — where a later
rebase restores it into a tree that had "already deleted" it.

**The rule:** for anything sensitive, deleting is step one of two. Confirm afterwards with
`git log --all -- <path>` that no commit carries it, and re-confirm **after** rebasing or merging
onto the shared branch, because that is when a copy from another branch can reappear.

**Why:** an untracked file feels safely outside git, so a delete looks final. It is not: the file
is one automatic `add --all` away from being permanent, and by then only a history rewrite removes
it.

**How to apply:** whenever removing credentials, personal data, or large accidental uploads. Treat
"the working tree is clean" and "the history is clean" as separate claims that need separate
evidence, and check the second one again once the branch has been rebased.
