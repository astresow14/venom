---
name: Sync failure indicators
description: How to key user-facing "unsaved work" UI off Venom's workspace SyncStatus without flicker or false alarms
---

The workspace `SyncStatus` cycles `error → syncing → error` while backoff retries run, and a normal save passes through `syncing` on every edit. Two rules for any indicator built on it:

- **Arm on failure only, never on `syncing`.** A slow-but-successful save must stay silent; only `error`/`too_large` may start the clock toward showing the indicator. Add a grace delay (the mobile chat notice uses ~4s) so a single blip that recovers on the first 1s retry never surfaces.
- **Let `syncing` sustain, only `synced` clears.** Keying visibility on `error` alone makes the indicator flicker off during every in-flight retry. Keep a deadline/visibility latched through `syncing` (a ref holding "due at", re-armed with remaining time on each status flip) and drop it only when the status leaves the unsynced set.

**Why:** built this way for the mobile chat "saved on this device only" notice; the retry cadence is 1s/2s/4s/… capped at 30s (`workspaceSyncRetryDelay`), so naive status-keyed UI blinks several times in the first ten seconds of an outage.

**How to apply:** any surface that reports unsaved/device-only work (chat notices, board notices, header icons) should reuse this arm-on-failure + sustain-through-retry pattern rather than rendering the raw status. Each app owns one shared hook that every such surface keys on — mobile's `useUnsyncedIndicator` (chat notice, board notice, and header cloud icon all consume it) and desktop chat's `useUnsyncedNoticeText` — so new surfaces call the app's hook, never re-derive from status. On mobile, stable no-cloud states (`offline`/`pending`/`loading`) are not failures: notices must ignore them, though the header cloud icon still shows cloud-off for them, and Settings is the one surface that deliberately renders the raw status readout.

**Desktop nuance — sustain `pending` too.** Desktop has no auto-retry backoff: after a failure the status parks at `error` until the sidebar Retry (straight to `syncing`) or the next edit's debounced flush (`pending → syncing`). If `pending` is not in the sustain set, every message written during an outage blinks the indicator off for ~5s. Mobile's auto-retry never passes through `pending` (there it is only the stable pre-import state), which is why its indicator omits it.

Testing: the mobile workspace sync harness (`venomWorkspaceSyncTest=true`, `failNextSaves(n)`) drives this end-to-end; n=4 failures keeps the workspace unsynced ~15s, comfortably past a 4s arming delay, before the fifth attempt lands and must clear the indicator. Desktop reuses the same URL param as an opt-in that lifts the UI-test sync pin and runs the real hydrate/debounce/save machinery against Playwright route stubs for `/api/venom/workspace` (no in-page harness; the spec flips a scriptable PUT stub between ok/fail, and a delayed failing PUT proves the mid-flight sustain). Mobile's regular UI-test mode pins status to `offline`, so such indicators must not trigger on `offline` or every unrelated spec would show them.
