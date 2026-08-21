#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push-force

# Mirror the merged state to GitHub as a pull request. Never fail setup over a
# network or credential hiccup -- the sync can always be re-run by hand.
#
# Every outcome is recorded in a marker file, and the drift check below re-reads
# it, so a sync that failed here is still visible afterwards from
# `pnpm run check:github-sync` rather than only in this log.
if [ "${VENOM_SKIP_GITHUB_SYNC:-}" != "1" ]; then
  pnpm run sync:github || echo "GitHub sync failed; run 'pnpm run sync:github' once the cause above is resolved."
else
  pnpm run sync:github -- --record-skip || true
fi

# Confirm the mirror really carries this merge. Reports drift, never blocks setup.
pnpm run check:github-sync || echo "GitHub mirror needs attention; see the check output above."
