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
