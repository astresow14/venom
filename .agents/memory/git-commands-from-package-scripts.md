---
name: Repo-wide git commands from a package script
description: Why any repo-wide git scan launched by a pnpm package script must be pointed at the repository root explicitly.
---

# Repo-wide git commands from a package script

A git command that walks paths — `ls-files`, `grep`, `add`, `clean` — is scoped to the **current
working directory**, not the repository. pnpm runs a package script with the cwd set to that
package's directory, so a repo-wide git query issued from a workspace package silently answers for
that package alone, with paths relative to it.

**The rule:** a script that needs the whole repository must resolve the root and target it
explicitly (`git -C <repoRoot> ...`), never rely on ambient cwd.

**Why:** the failure mode is silence, not an error. A scan narrowed to one package still exits 0
and reports "clean", which is indistinguishable from actually being clean.

**How to apply:** whenever a script shells out to git for a repo-wide answer. Verify it by planting
a matching file *outside* the script's own package — running the check from the repository root
passes either way and proves nothing.
