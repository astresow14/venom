---
name: Managed AI provider provisioning
description: Replit-managed Anthropic/Gemini/OpenRouter credentials cannot always be provisioned from a task environment; plan multi-provider work around that.
---

# Managed AI provider provisioning

The sandbox callback for the non-OpenAI Replit AI Integration providers can be
absent from a task environment. When it is absent entirely (rather than
returning an error), retries cannot provision credentials.

**Why:** an unavailable callback is a platform capability gap, not a transient
provider failure, so treating it as retryable only obscures the real decision.

**How to apply:**
- Before planning work whose acceptance depends on a non-OpenAI managed
  provider, probe for the provisioning callback first; if it is undefined, the
  provisioning half of the work is blocked and only the surrounding plumbing can
  be delivered.
- Keep unconfigured providers reporting an explicit "not configured" state.
  Never silently reroute a model alias to a provider that *is* configured — a
  hidden fallback makes the gap invisible and misattributes the response.
- The user-supplied-API-key fallback suggested by the integration skills is a
  real option, but it changes the product promise (managed, no key requested),
  so it needs an explicit decision rather than a quiet substitution.
