#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push-force

# Mirror the merged state to GitHub as a pull request. Never fail setup over a
# network or credential hiccup -- the sync can always be re-run by hand.
if [ "${VENOM_SKIP_GITHUB_SYNC:-}" != "1" ]; then
  pnpm run sync:github || echo "GitHub sync skipped; run 'pnpm run sync:github' once the cause above is resolved."
fi
