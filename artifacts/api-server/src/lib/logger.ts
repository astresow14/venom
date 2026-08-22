import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export type ApiLoggerOptions = {
  /** Log level; defaults to LOG_LEVEL, then "info". */
  level?: string;
  /**
   * Optional in-process destination (e.g. a capture stream in tests). When
   * set, lines go to this stream and the pretty transport is skipped, so the
   * destination receives exactly the production-shaped output.
   */
  destination?: pino.DestinationStream;
};

/**
 * Build a logger with the API server's production configuration — level,
 * redaction rules, and transport selection — in one place. The provider
 * model-ID leak-guard suite uses this factory with a capture destination so
 * it scans exactly what production logging would emit; runtime code uses the
 * shared `logger` below.
 *
 * Redacted fields:
 * - Standard HTTP auth headers and cookies
 * - Any field named token, secret, password, credential, apiKey, api_key,
 *   privateKey, private_key, accessKey, access_key, clientSecret, client_secret,
 *   bearer, authorization, objectPath, packageObjectPath, checksumSha256
 *   (to avoid leaking source/package material in log payloads)
 */
export function createApiLogger(options: ApiLoggerOptions = {}): pino.Logger {
  const pinoOptions: pino.LoggerOptions = {
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
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
    // does not exist, so tests and capture destinations run without one.
    ...(isProduction || process.env.NODE_ENV === "test" || options.destination
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: { colorize: true },
          },
        }),
  };
  return options.destination
    ? pino(pinoOptions, options.destination)
    : pino(pinoOptions);
}

export const logger = createApiLogger();
