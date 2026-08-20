---
name: instrument-observability
description: Adds safe production logging, health checks, and graceful error handling to APIs, services, jobs, and production features. Use when building or changing backend or deployable code.
---

# Instrument observability and graceful errors

Make production behavior diagnosable without exposing internals.

- Emit structured, useful logs at request boundaries, errors, and significant state changes. Include IDs, operation names, and timing; never include secrets, tokens, passwords, PII, or whole request payloads.
- Catch and log detailed server errors, but return generic client-safe messages and correct 4xx/5xx status codes.
- Keep a lightweight health endpoint that confirms the service and critical dependencies are reachable.
- Make background jobs report success and failure clearly; repeated failure must not be silent.
- Include enough safe context in logs to investigate downtime quickly.
- Watch for obvious CPU/memory risks and guard against avoidable leaks.

## Before delivery

State which logging, error handling, and health checks exist, and confirm no sensitive data is returned or logged.