---
name: Orval generated EOF normalization
description: Why generated API files need a tail check after every OpenAPI regeneration.
---

After running Orval, inspect generated TypeScript files with `git diff --check`. This workspace's generator can leave extra blank lines at EOF; the generated Zod module may need a harmless `export {};` terminator to keep the tail stable.

**Why:** Successful generation and typechecking do not catch the whitespace failure, and repeated generation can restore it.

**How to apply:** After every OpenAPI codegen run, normalize only the generated file tails, rerun library typechecks, and require `git diff --check` before completion.