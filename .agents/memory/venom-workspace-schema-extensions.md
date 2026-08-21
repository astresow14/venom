---
name: Venom workspace schema extensions
description: Rules for adding a new field to the synced Venom workspace state without breaking older payloads or cross-device sync.
---

A new field on the synced workspace state must be: optional in the OpenAPI schema, bounded with an explicit `maxItems` (collections), normalized on hydration, and merged explicitly in the cross-device merge.

**Why:** The workspace is a single JSON blob validated server-side against the generated contract and rejected above a fixed byte budget. A required field breaks every stored payload written before it existed; an unbounded collection eventually trips the size limit; and the merge function rebuilds the state object field by field, so anything not listed there is silently dropped whenever two devices reconcile.

A field the user edits directly (a setting attached to an entity, not a snapshot of remote
data) additionally needs its own change timestamp, and any "switched off" state must be a
recorded value rather than an absent field.

**Why:** the merge resolves each entity by one freshness timestamp that only the sync itself
moves, so a setting changed between syncs is invisible to it: a second device holding the
older entity wins on an unrelated edit and silently reverts the setting. An absent field
means "this device has no opinion", which is why switching a setting off has to be recorded
explicitly to beat a device that still has it on. Prefer epoch-millisecond numbers for new
timestamps: the Zod client is generated with date coercion while the React query client
keeps strings, so a `date-time` field arrives as a `Date` on one side and a `string` on the
other.

**How to apply:** Edit the spec, regenerate the clients (then check generated file tails — see the Orval EOF note), mirror the schema's cap as a client-side constant used by the merge/normalize helpers, and cover the field with a generated-contract test on the server (accepted at the cap, rejected past it) plus a merge test proving both devices' entries survive.

**Two clients own normalize/merge copies.** Mobile (`workspaceSync`) and Venom Desktop (`workspaceState`) each rebuild `voicePreferences`, `modelPreferences`, etc. field by field. A field added to only one client is stripped the next time the *other* client hydrates and saves — the sync then propagates the stripped object back, quietly resetting the originating device. Every schema extension must land in both normalizers (with the same default for legacy payloads) and be proven by a cross-client round-trip test: hydrate a cloud state carrying the new field on the client that did NOT introduce it, merge, prepare-for-save, and assert the field survives the save payload.
