import app from "./app";
import { logger } from "./lib/logger";
import { startCommunityNotificationRetentionJob } from "./lib/community-notifications";
import { startVenomIdentityRetentionJob } from "./lib/venom-identity-retention";
import { startVoiceDecisionRetentionJob } from "./lib/venom-voice-decision-store";
import { ensureMasterReadGate } from "./lib/venom-master-ontology";
import { ensureSuperAdminBootstrap } from "./lib/venom-super-admins";
import { ensureVenomBuildTemplateSeed } from "./lib/venom-build-template-seed";
import {
  geminiDirectCredentialInUse,
  startGeminiDirectCapabilityRecovery,
} from "./lib/venom-models";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Warm the master-ontology read gate: it runs the identity-policy sweep
// (purging pre-policy rows) before any master read is served. Reads stay
// fail-closed until the sweep succeeds, so a warm-up failure only defers
// them; each later read retries the sweep.
void ensureMasterReadGate().catch((err) => {
  logger.error({ err }, "master identity policy sweep failed");
});

// Designate the configured owner account as the first super admin. Fire and
// forget: a failure here (auth provider unreachable, account not yet signed
// up) only defers designation — the role check retries the bootstrap lazily
// under a cooldown, so no manual step is ever required.
void ensureSuperAdminBootstrap(logger).catch((err) => {
  logger.warn({ err }, "super admin bootstrap failed at boot");
});

// Seed the curated build-template starter set. Insert-only on slug, so a
// redeploy can never overwrite ops edits; a boot-time failure just means
// the catalog stays as it was.
void ensureVenomBuildTemplateSeed().catch((err) => {
  logger.warn({ err }, "build template seed failed at boot");
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startCommunityNotificationRetentionJob();
  startVenomIdentityRetentionJob();
  startVoiceDecisionRetentionJob();

  // Whenever a direct Gemini key is configured the client will use it — even
  // if the managed pair is also set — so the catalog marks venom-gemini Ready
  // only after this check confirms catalog access. A failed check re-runs on
  // a bounded backoff, so a transient blip here cannot park Gemini offline
  // until a restart; a later pass flips the catalog to Ready on its own.
  // Verdicts are safe to log: reasons never carry credentials, prompts, or
  // provider model IDs.
  if (geminiDirectCredentialInUse()) {
    startGeminiDirectCapabilityRecovery({
      onVerdict: ({ result, attempt, nextRetryDelayMs }) => {
        if (result.ok) {
          logger.info(
            attempt > 0
              ? "Gemini capability check passed after re-check; venom-gemini is enabled"
              : "Gemini capability check passed; venom-gemini is enabled",
          );
        } else if (nextRetryDelayMs !== null) {
          logger.info(
            { reason: result.reason, attempt, nextRetryDelayMs },
            "Gemini capability check did not pass; venom-gemini stays not configured until a re-check passes",
          );
        } else {
          logger.info(
            { reason: result.reason },
            "Gemini capability check did not pass; venom-gemini stays not configured",
          );
        }
      },
    });
  }
});
