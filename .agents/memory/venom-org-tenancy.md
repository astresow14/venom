---
name: Venom org tenancy
description: Why company workspaces are first-party DB tables instead of Clerk organizations, and the contracts clients rely on.
---

# Venom org tenancy (companies / shared Brain)

**The rule:** Organization tenancy is first-party: companies, membership, invites, shared projects, org sources, and the promotion audit are our own owner-scoped Postgres tables. Clerk stays identity-only (user ids, verified emails, names).

**Why:** The Replit-managed Clerk instance rejects the Organizations API (403 `organization_not_enabled_in_instance`) and the feature cannot be enabled from our side.

**How to apply:**
- Never reach for `clerkClient.organizations`; extend the first-party tables. Invites bind to Clerk-verified emails; every org-scoped route re-checks membership server-side.
- Org knowledge reuses the owner-scoped ontology tables and the one shared merge path (see venom-ontology-store.md). Filing is decided server-side — clients never file work into a company scope locally; they learn the outcome from the server's response.
- Company data on a device is a read-only mirror: drop it on confirmed membership end (push event, 403/404, or directory refresh), never on a transient fetch failure.
