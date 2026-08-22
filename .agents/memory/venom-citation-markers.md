---
name: Venom citation markers stay until display
description: Why inline [source:...] markers are resolved when rendered rather than stripped when text is written or stored.
---

Assistant answers store citations as inline `[source:<citation-id>]` markers, and any
text derived from an answer (chat previews, knowledge cluster summaries, cluster source
excerpts) inherits them. The rule: keep the marker in stored text and resolve it at the
moment it is rendered; never strip it at write time, and never render stored text raw.

Resolution has three outcomes a reader should see: the live source's title, the archived
reference of a source a refresh or disconnect retired, and a generic archived label for a
marker nothing knows about (including an unterminated marker from a truncated stream).

**Why:** stripping at write time permanently destroys the attribution and leaves gaps
("Blocked by  until Friday"), while a marker resolved at render time keeps naming its
evidence as the source set changes underneath it — and it repairs text that was stored
before the fix. The only place a marker is stripped outright is a *label*: labels are
short identity strings that get matched, merged and renamed, so a marker there can only
read as machine text.

**How to apply:** any new surface that displays answer-derived text must route it through
the shared plain-text/segment renderer with the project's live citation map plus the
archived-citation map. Adding a surface without that lookup is the regression this guards
against — cover it with a browser test that asserts the rendered text contains no
`[source:` and does name the source.

The display rulebook (marker grammar, segment parser, archived wording, flattening,
knowledgeDisplayText) has one home: the shared workspace lib `@workspace/knowledge-text`,
re-exported by both apps under their historical module paths and guarded by each app's
`citationRules.test.mjs` reference-identity tests — change wording/parsing only in the lib.
The phone-only refresh/remap machinery stays app-local, importing the lib's marker-pattern
factory so the grammar cannot fork. Server copies (exports, knowledge extraction) remain
separate on stored types, like the merge rules.

## The citation jump is a two-client parity surface

Cited answers on BOTH clients offer "open the evidence" chips that land on the cited
source card — and on the exact quoted row when the jump carries a citation id. The jump
semantics (a citation id only counts alongside its source; missing or cross-project
targets explain themselves in a notice; leaving the view retires the markers and the
scroll parked on them) are mirrored between the mobile knowledge screen and the desktop
Brain sources view, each guarded by its own browser suite. Change this flow in one app
only in lockstep with the other — sibling tasks have already landed one-sided improvements
here (the notice's one-tap project switch shipped mobile-first), so diff the twin surface
before and after editing it. Any action that mounts the jump target must also shed the
user's source filter, or the parked scroll can never resolve.
