---
name: no-hardcoded-secrets
description: Prevents credentials from entering source code or browser bundles. Use whenever wiring API keys, tokens, passwords, connection strings, OAuth secrets, or before publishing.
---

# Keep secrets out of code

- Put every credential in an environment variable or Replit Secret. Read it at runtime; never paste literal values into source or config.
- Never expose server credentials to the browser, localStorage, sessionStorage, client JavaScript, HTML, or API responses.
- Keep third-party calls that require secrets on the server.
- Before publishing or committing, scan changes for API keys, tokens, passwords, private keys, and credential-bearing connection strings.
- If a real secret entered git history, treat it as compromised: rotate it at the provider. Removing it from the latest change is not sufficient.

## Before delivery

Confirm that no credential is hardcoded and that secrets are referenced only through environment variables or Replit Secrets.