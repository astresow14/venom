---
name: secure-ai-features
description: Protects chatbots, assistants, RAG, summarizers, and AI agents against prompt injection, unsafe output handling, and excessive agency. Use for any feature that sends user or external content to an LLM.
---

# Secure AI features against prompt injection

Treat model input and output as untrusted.

- Constrain the system prompt with role, allowed tasks, boundaries, and instructions to ignore attempts to override core behavior.
- Never put secrets or privileged instructions where user or external content can reach them.
- Validate and sanitize model output before any action. Never feed it directly into shell commands, SQL, eval, or the DOM.
- Enforce least privilege: implement capabilities in application code with narrowly scoped tokens rather than granting broad model access.
- Require explicit human approval before high-risk or irreversible actions such as sending money, deleting data, or contacting customers.
- Mark and segregate external content—web pages, uploads, documents, emails, and third-party data—as untrusted reference data, not instructions.
- Do not expose the system prompt or infrastructure details in responses.
- Test adversarially for instruction override, data exfiltration, and unauthorized tool use before releasing.

## Before delivery

State the applicable defenses, especially tool/data access limits and human approval for risky actions.