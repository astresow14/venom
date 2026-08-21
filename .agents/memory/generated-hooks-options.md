---
name: Generated react-query hook options
description: Passing query options to the Orval-generated hooks silently drops the default query key unless you restate it.
---

**Rule:** When calling a generated hook with `{ query: { enabled, staleTime, … } }`, always pass the generated key getter explicitly: `{ query: { queryKey: getXxxQueryKey(params), enabled } }`. The generated types require it, and omitting it (or hand-writing a key) breaks cache identity with everything else that uses the getter.

**Why:** The generated options type makes `queryKey` mandatory once you supply a `query` object; TypeScript errors here read as opaque overload failures, and a mismatched hand-rolled key silently splits the cache (invalidation by the getter no longer reaches the entry).

**How to apply:** Import the matching `get<Operation>QueryKey` next to each `use<Operation>` whenever options are passed. Account-scoped caches may append suffix elements to the getter's array (spread it first) — prefix-based eviction still works because the generated key's first element is the URL string.
