/**
 * Boot-time + periodic retention job for per-user identity records.
 *
 * Lazy deletion (venom-identity.ts) removes a deleted account's name and
 * email the next time that identity is resolved — but an identity nobody
 * resolves again would keep its personal data forever. This job closes the
 * gap: at startup and on an interval it re-verifies rows unrefreshed for
 * the sweep window and deletes the ones whose accounts are gone upstream.
 *
 * PII discipline: identity rows hold names and emails, so this job logs
 * counts and durations only — never row values — and a sweep failure is
 * reduced to its error type. Failures never block startup: the first sweep
 * runs off the listen path, every error is contained here, and the timer
 * never keeps the process alive.
 */
import { logger } from "./logger";
import { sweepStaleVenomIdentities } from "./venom-identity";

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let retentionJobStarted = false;

export function startVenomIdentityRetentionJob(): void {
  if (retentionJobStarted) return;
  retentionJobStarted = true;

  const sweep = async () => {
    const startedAt = Date.now();
    try {
      const result = await sweepStaleVenomIdentities();
      logger.info(
        {
          ...result,
          durationMs: Date.now() - startedAt,
          op: "sweep_venom_identities",
        },
        "Venom identity retention sweep finished",
      );
    } catch (error) {
      logger.error(
        {
          durationMs: Date.now() - startedAt,
          errorType: error instanceof Error ? error.name : "UnknownError",
          op: "sweep_venom_identities",
        },
        "Venom identity retention sweep failed",
      );
    }
  };

  setImmediate(() => void sweep());
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref();
}
