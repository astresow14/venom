---
name: Orval generated normalization
description: Why generated API files must be regenerated after contract merges and checked for unstable tails.
---

Regenerate Orval outputs after any merge or rebase that touches the OpenAPI contract or generated files; never trust a textual merge of generated Zod output. Then inspect generated TypeScript with `git diff --check`. The generator can leave extra blank lines at EOF, so a harmless `export {};` terminator may be needed to keep the tail stable.

**Why:** A textual merge can reorder generated schema constants, causing compile-time use-before-declaration errors or runtime `undefined` validators. Successful generation and typechecking still do not catch the separate whitespace failure, and repeated generation can restore it.

**How to apply:** After contract merges, run the canonical OpenAPI codegen command instead of repairing generated files by hand. Normalize only generated tails afterward, rerun the full typecheck and contract-backed tests, and require `git diff --check` before completion. For route-critical generated schemas, keep a direct import-and-parse regression because typechecking may pass while runtime initialization still supplies an undefined validator.

Cross-package drift: the one spec (lib/api-spec/openapi.yaml) generates two sibling copies — api-zod's types and api-client-react's api.schemas.ts. A replayed auto-merge can revert one copy while the other stays current, and nothing fails until some consumer file happens to reference the missing surface (the client package exports raw src, so no build step notices). Symptom: a consumer typecheck error on a generated property that plainly exists in the yaml and in the sibling package. Fix is never hand-editing: `pnpm --filter ./lib/api-spec run codegen` regenerates both; expect a large diff when the stale copy missed several merges, then rerun the full workspace typecheck.

Consumer-side gotcha: this workspace's generated react-query hooks type their `query` options so an explicit `queryKey` is required — call `useGetX(..., { query: { queryKey: getGetXQueryKey(...), ... } })`. Omitting it is a type error even though vanilla react-query would infer it; both clients already follow this convention.
A task merge can also land regenerated output produced from a mid-rebase spec, silently dropping fields the current spec still declares (typecheck breaks in consumers, runtime validators strip the fields). When hand-written code references fields the generated types lack, run the canonical codegen from HEAD's spec before debugging the hand-written side — it can fix typecheck and runtime in one step.
