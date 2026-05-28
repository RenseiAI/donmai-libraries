# Third-Party License Review

This document tracks dependency licenses that fall outside the standard OSS
allowlist (`MIT`, `Apache-2.0`, `BSD-*`, `ISC`, etc.) and require manual review.

## @anthropic-ai/claude-agent-sdk

| Field | Value |
|---|---|
| **Package** | `@anthropic-ai/claude-agent-sdk` |
| **Version** | `^0.2.7` (resolved 0.2.37 at time of review) |
| **License field** | `SEE LICENSE IN README.md` |
| **Actual license** | Proprietary — "All rights reserved" |
| **License text** | `LICENSE.md`: *"© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance."* |
| **Governing terms** | [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms) (API/Team/Enterprise) or [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (Free/Pro/Max) |
| **Used by** | `@donmai/core` (core), `@donmai/plugin-linear` |
| **CI status** | Excluded from automated license-checker via `--excludePackages` flag |
| **Review status** | APPROVED (reviewed 2026-03-23, see SUP-1227) |

### Key findings

1. **Not OSS.** The SDK is published on npm but is *not* released under an open-source
   license. The `LICENSE.md` is a one-line copyright notice pointing to Anthropic's
   legal agreements.

2. **Usage is permitted.** The Commercial Terms (Section A.1) grant permission to
   "use the Services to power products and services Customer makes available to its
   own customers and end users." AgentFactory's use of the SDK to orchestrate agents
   falls within this grant.

3. **Redistribution is permitted.** Listing the SDK as a dependency in a published
   npm package is standard npm behavior (transitive installation, not direct
   redistribution of Anthropic's code) and is permitted under Anthropic's commercial
   terms. Confirmed by Anthropic (thariq@anthropic.com) — see SUP-1227.

4. **Authentication restriction.** OAuth tokens from Free/Pro/Max plans may **not** be
   used with the Agent SDK. Only API key authentication is permitted for developers
   building products. This is documented at
   https://code.claude.com/docs/en/legal-and-compliance.

### Review outcome (2026-03-23)

Human review completed (SUP-1227). Findings:

- [x] Listing `@anthropic-ai/claude-agent-sdk` as a production dependency in a published npm package is **permitted**
- [x] No additional attribution or notice is required beyond what is documented here
- [x] Anthropic confirmed directly (thariq@anthropic.com) — no need to contact sales

**Additional notes from review:**
- Anthropic reserves the right to limit access based on subscription tier (Max vs API keys)
- Their terms do not allow hosting a for-profit service using a Max subscription — only API keys are permitted for product use
- The SDK remains excluded from automated license-checker via `--excludePackages` flag; this is expected since it is not an OSS license

## FOSSA License Policy

For the complete license policy configuration used with FOSSA, see [docs/license-policy.md](docs/license-policy.md).
