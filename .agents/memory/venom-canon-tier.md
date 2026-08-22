---
name: Venom canon teaching tier
description: Super-admin-authored global canon — role bootstrap, opaque denial, teach-in-chat flow, and reference-only prompt injection.
---

- Super admin is a server-side designation stored by resolved auth-provider account id. Bootstrap resolves one configured verified email (env `VENOM_SUPER_ADMIN_BOOTSTRAP_EMAIL`) to its account id once; it fails closed when unconfigured — the value lives only in non-versioned secret config, never in code or committed files, and emails are never logged. Request-time email matching never authorizes anything. Grant/revoke guard self-revocation and the last remaining admin (row-locked so concurrent revokes cannot empty the table); the role is re-checked live on every privileged request.
- Every canon endpoint refuses unauthorized callers with the same opaque denial pattern workspace membership uses — one fixed body, byte-identical across endpoints; tests assert exact equality.
- Teach-in-chat: client gates are cheap prefilters that only decide whether to call propose; the server re-gates intent and distills through the same normalize→bound→validate contract as knowledge extraction. Every miss or error fails open to an ordinary chat turn — teach detection must never eat a message. Commits happen only from the confirmation card.
- Canon reaches responses as bounded, sanitized reference data only: a tagged envelope, entry- and char-capped, topic-qualified against the recent window, inserted beside the SOP block. Never instructions; the persona's verbatim factual core stays untouched; retired entries drop out of prompt assembly.
- The teach gate is deliberately duplicated per app — mirror edits in both clients; admin-gated chrome needs the identity query active in UI-test mode or browser specs cannot exercise it.

**Why:** canon shapes every user's answers, so the only boundaries that hold are server-side role checks, opaque refusals, and reference-only framing; client checks exist purely to save round-trips.

**How to apply:** any new canon surface or endpoint copies the exact denial body, re-verifies the role server-side, keeps prompt text inside the bounded envelope, and mirrors gate changes across both apps.
