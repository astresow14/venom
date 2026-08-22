---
name: Venom markdown exports
description: Durable decisions behind the .md download feature — client-side filenames, in-document withholding, native share delivery.
---

# Venom markdown exports

**Rules:**
- The generated client strips response headers, so `Content-Disposition` never reaches app code: each app re-derives the export filename locally from the same date-stamped pattern. The filename logic is deliberately duplicated per surface and must change in lockstep.
- Withholding is part of the document contract, not an HTTP signal: when workspace policy blocks sensitive items, the markdown itself opens with an explicit "N item(s) withheld" statement. Clients deliver the body verbatim — no client-side filtering exists, so new export surfaces inherit policy enforcement by calling the same endpoints.
- Mobile native delivery hands the markdown text to the OS share sheet instead of writing a file; file-system/sharing packages are deliberately not installed.

**Why:** export enforcement must live server-side (a UI-only lock protects nothing), and surfacing headers would mean reworking the shared fetch layer for every consumer.

**How to apply:** a new export kind or surface extends the server renderer + OpenAPI, regenerates clients, and reuses the per-app filename/delivery helpers; never parse or filter markdown client-side, never rely on Content-Disposition reaching app code.
