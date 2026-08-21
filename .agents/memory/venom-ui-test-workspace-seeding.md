---
name: Seeding Venom workspace fixtures for browser tests
description: How to put an arbitrary multi-project workspace in front of a UI-test browser session on both clients, and the timing trap.
---

Both clients read the UI-test account's own scoped storage at startup, so a browser test can
seed any workspace shape (multiple projects, clusters, conversations) with a single
`addInitScript` that writes the serialized state under that key — no network stubs and no
in-app clicking to build fixtures.

- Desktop: `localStorage` under `@venom_desktop_v1:venom-desktop-ui-test`, read synchronously
  when the provider mounts. Only consulted when no `brainFixture` query override is present.
- Mobile (Expo web): AsyncStorage is plain `localStorage` on web — key
  `@venom_state_v2:venom-ui-test`, restored by the async hydration effect.

**Why:** the built-in UI-test fixtures are single-project; anything exercising cross-project
behavior needs a seeded workspace, and building it through the UI is slow and couples the test
to unrelated flows.

**How to apply:** seed a state that passes the loose validation (arrays for `projects`,
`conversations`, `clusters`; normalization fills tombstones, board stages, model prefs). On
mobile, hydration is asynchronous and replaces the default state after first paint — wait for a
seeded-only signal (e.g. the active project's name in the header) before interacting, or the
test races the default workspace. Desktop needs no such wait.
