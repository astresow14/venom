import { sweepStaleTestUsers } from './clerk-backend';

/**
 * Global setup for the live auth-flow suite.
 *
 * 1. Fails the run immediately — before any browser or retry spends
 *    minutes — when the Clerk credentials the suite depends on are
 *    missing. The automated validation runner must fail loudly here,
 *    never pass silently with skipped tests.
 * 2. Sweeps stale +clerk_test accounts left behind by earlier runs whose
 *    afterAll cleanup never ran, so the routine per-task-completion
 *    cadence cannot accumulate users on the Clerk dev instance.
 */
export default async function globalSetup(): Promise<void> {
  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error(
      'CLERK_SECRET_KEY is not set. The live auth suite drives the real ' +
        'Clerk credential flow and must fail loudly rather than silently ' +
        'skip when the backend key is missing.',
    );
  }
  if (
    !process.env.CLERK_PUBLISHABLE_KEY &&
    !process.env.VITE_CLERK_PUBLISHABLE_KEY
  ) {
    throw new Error(
      'CLERK_PUBLISHABLE_KEY is not set. The live auth suite cannot load ' +
        'the real Clerk forms without it.',
    );
  }
  await sweepStaleTestUsers();
}
