import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Redacted fields:
 * - Standard HTTP auth headers and cookies
 * - Any field named token, secret, password, credential, apiKey, api_key,
 *   privateKey, private_key, accessKey, access_key, clientSecret, client_secret,
 *   bearer, authorization, objectPath, packageObjectPath, checksumSha256
 *   (to avoid leaking source/package material in log payloads)
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      // HTTP headers
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      // Credential-like field names (anywhere in log objects)
      "*.token",
      "*.secret",
      "*.password",
      "*.credential",
      "*.credentials",
      "*.apiKey",
      "*.api_key",
      "*.privateKey",
      "*.private_key",
      "*.accessKey",
      "*.access_key",
      "*.clientSecret",
      "*.client_secret",
      "*.bearer",
      "*.authorization",
      // Source/package object paths and checksums must never be logged
      "*.objectPath",
      "*.packageObjectPath",
      "*.checksumSha256",
      "*.checksum",
    ],
    censor: "[REDACTED]",
  },
  // The pretty transport spawns a worker thread whose script path resolves
  // relative to the running file; under bundled integration tests that path
  // does not exist, so tests run without a transport.
  ...(isProduction || process.env.NODE_ENV === "test"
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
