---
name: Approved build-package boundary
description: Safety and durability rules for Venom's product-generation packages.
---

Package generation must stop at an immutable, human-approved specification. Approval can only make that package ready for a separate provisioning step; it must never execute code, publish, deploy, contact customers, access credentials, or approve itself.

Pinned app versions and SOP revisions are historical inputs, not ordinary live relationships. Preserve their identifiers even when the source record is later deleted, and fail generation explicitly if a pinned input can no longer be resolved.

**Why:** Reviewability and reproducibility depend on approval having a narrow, non-executing meaning and on a completed or queued run retaining the exact input identity that an actor selected.

**How to apply:** Keep generation workers database-claimed and recoverable, validate and normalize model output before persistence, replace model-supplied references with server-authorized pins, and put any future provisioning behavior behind a distinct user-controlled workflow.