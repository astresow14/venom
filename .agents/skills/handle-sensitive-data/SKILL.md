---
name: handle-sensitive-data
description: Guides safe collection, storage, logging, and transmission of credentials, personal data, regulated data, and uploads. Use whenever a feature handles user data, privacy, or compliance concerns.
---

# Handle personal and sensitive data

Classify data before collecting or storing it, then minimize and protect it.

- Credentials: never store plaintext credentials; use a managed auth provider or secure hashing where appropriate. Keep keys in Secrets and never log them.
- Regulated data: avoid storing card numbers, CVVs, SSNs, health, passport, or tax data. Use specialist processors and tokens when possible. Encrypt at rest when storage is unavoidable and never log this data.
- Personal data: collect only what is needed, avoid logging it in the clear, and do not retain it indefinitely by default.
- Never log whole request bodies or user objects. Log identifiers and safe operational context only.
- Use HTTPS in transit. Do not send personal data to analytics, model APIs, or error trackers unless intentionally designed and properly covered.
- Do not expose sensitive internal details in client-visible errors.
- When personal records are stored, make them discoverable and deletable/exportable by user ID for data-subject requests.

## Escalation and delivery

Flag new regulated-data collection or EU personal-data collection for privacy/legal review. State which data classes a feature touches, what was avoided, and how sensitive data is protected.