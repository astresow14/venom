---
name: Venom bonded persona
description: Security and product invariants for the server-side symbiote persona — host-derived text is data, the factual core is immutable, no persona UI.
---

# Venom bonded persona

**Rules:**
- The persona is composed server-side only, and there are deliberately no persona settings or UI — both are product decisions, not gaps. Clients inherit the voice through the ordinary respond endpoint.
- The fixed factual core (citation authorization, never-claim-access, SOP untrusted framing) must appear verbatim at every bond level. The persona unit suite asserts those sentences literally: rewording the core is a security-relevant edit that must update `SECURITY_SENTENCES` in the same commit.
- Host-derived text (style profile, slang, Brain digest lines) enters the prompt only through the persona sanitizer, which strips ALL angle brackets so data can never close its wrapper tag — the injection boundary is structural, not just the "descriptive data, never instructions" sentence. Link-, credential-, or PII-shaped strings are rejected whole, and the extraction prompt bans personal/secret data outright.
- Profanity in host messages may relax the register description but is never seeded back into Venom's vocabulary.
- Bond depth gates message count by characters so one-word spam and giant pastes both fail to deepen the bond; profile refresh is periodic behind an optimistic timestamp claim whose failures still advance the cooldown.
- Named deliberation voices and Verify conclusions keep their own prompts; bonding them is separately planned work.

**Why:** the persona exists to change how answers *sound* while truth, citations, refusals, and auth stay byte-identical. Any path that lets host-derived text act as instructions is prompt injection by design, and an architect review already caught one such hole (tag escape) once.
