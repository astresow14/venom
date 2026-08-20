---
name: check-dependency-licenses
description: Reviews dependency licenses before adding packages or releasing a commercial product. Use when adding a dependency or when license, IP, or commercial-use safety is relevant.
---

# Check dependency licenses

Before adding a dependency to a closed-source or commercial product, inspect its license.

- MIT, ISC, BSD, and Apache-2.0 are generally safe to ship.
- GPL-2.0, GPL-3.0, AGPL, and SSPL are high risk for proprietary software. Do not add them without explicit legal sign-off.
- LGPL and MPL-2.0 are conditional. Flag them and confirm the organization’s policy.
- A missing or unknown license is not safe; find the real license before relying on the package.
- If a package is unsuitable, look for a permissively licensed alternative. If none exists and the feature is essential, ask the user for a business/legal decision.
- Never strip or alter license text to avoid an obligation.

## Before delivery

Report the licenses of new dependencies and flag anything that is not clearly permissive for review.