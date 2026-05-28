# Plugin Signing (Sigstore)

Default-signed plugin posture for the Donmai platform. Productionizes
the signing CI scaffolding, including keyless Sigstore signing and
trusted-issuer verification.

> Architecture references:
> [`015-plugin-spec.md` §Auth + trust](../../donmai-architecture/015-plugin-spec.md)
> and [`002-provider-base-contract.md` §Signing and trust](../../donmai-architecture/002-provider-base-contract.md).

## Why default-signed

Plugins are first-class extension points: they register Provider
implementations and Workflow verbs that run inside the host process with
host-level privileges. A compromised plugin can exfiltrate tokens, launch
sandboxes, or run arbitrary deployments. We mitigate that risk by:

1. **Signing every plugin tarball at publish time** via Sigstore Fulcio +
   Rekor, using GitHub Actions OIDC for keyless ephemeral certs.
2. **Verifying the signature on load** against a configured
   trusted-issuer set.
3. **Failing loudly** when a tampered tarball is detected — under
   `strict` trust mode the load is rejected; under `permissive` the
   signature mismatch is still rejected (we never silently activate
   tampered content) and unknown-but-cryptographically-valid signers
   downgrade to a warning.

## Components

| Layer | File | Responsibility |
|------|------|----------------|
| CI signing | `.github/workflows/plugin-sign.yml` | Pack tarball, request Fulcio OIDC cert, sign, push to Rekor, attach bundle to Release. |
| Verifier | `packages/core/src/providers/verifiers/sigstore.ts` | Bundle verification via `@sigstore/verify` (graduated to a regular dependency). |
| Loader gate | `packages/core/src/plugins/loader.ts` | Calls `checkTrustedIssuer` after signature verification; rejects under strict mode. |
| Trust set | `packages/core/src/plugins/trusted-issuers.ts` | Module-level singleton holding the trusted-issuer list. |

## Required GitHub *org* secrets

Provision these once at the GitHub organization level so the workflow
can sign tarballs in any repo under the org. The user owns provisioning;
the agent only documents the names + scopes.

| Secret | Required | Default | Purpose |
|--------|----------|---------|---------|
| `FULCIO_URL` | optional | `https://fulcio.sigstore.dev` | Override only when running a self-hosted Sigstore deployment. |
| `REKOR_URL` | optional | `https://rekor.sigstore.dev` | Same — public good Sigstore service is the default. |
| `OIDC_AUDIENCE` | optional | `sigstore` | Override only if your private Fulcio deployment expects a different audience claim. |
| `REGISTRY_PUBLISH_TOKEN` | optional | — | Used only when the workflow is extended to push to a private registry. Not consumed in the shipped workflow. |

The workflow itself uses the **GitHub-provided** `id-token: write`
permission to obtain an OIDC token — that does not require a secret.
The default Sigstore endpoints are public goods; most teams will leave
the URL knobs unset.

### How to provision (out-of-band)

1. Open `https://github.com/organizations/<org>/settings/secrets/actions`.
2. Click **New organization secret** for each name above.
3. Set repository access to *All repositories* (or restrict to
   `agentfactory` + plugin repos).
4. Confirm by manually dispatching `plugin-sign.yml` with a known
   plugin/version pair and observing a green run with a Rekor entry.

## Trust modes

The plugin loader exposes a *plugin-loader-level* `trustMode`:

| Mode | Unsigned plugin | Signed but untrusted issuer | Signed by trusted issuer |
|------|-----------------|-----------------------------|--------------------------|
| `permissive` (default) | warn + accept | warn + accept | accept |
| `strict` | **reject** | **reject** | accept |

This sits one level above the provider-base `TrustMode`
(`permissive` / `signed-by-allowlist` / `attested`). The two compose:
the provider-base mode handles the cryptographic + attestation policy;
the plugin-loader mode handles the trusted-issuer gate.

Configure on the loader:

```ts
import { PluginLoader } from '@donmai/core'

const loader = new PluginLoader({
  trustMode: 'strict',
  trustedIssuers: {
    mode: 'production',
    issuers: [
      {
        name: 'Rensei Plugin Sign Workflow',
        subject:
          'https://github.com/RenseiAI/donmai-libraries/.github/workflows/plugin-sign.yml@refs/heads/main',
        algorithms: ['sigstore'],
      },
    ],
  },
  requireSignatures: true,
})
```

Or set the module-level singleton at startup:

```ts
import { setTrustedIssuerSet } from '@donmai/core'

setTrustedIssuerSet({
  mode: 'production',
  issuers: [
    /* ... */
  ],
})
```

## Trusted issuer set

The shipped trusted-issuer set is a **placeholder stub**
(`PLACEHOLDER_TRUSTED_ISSUERS` in `trusted-issuers.ts`). The real Rensei
official cert chain is governance-sensitive and is provisioned out of
band.

Operators must:

1. Populate the trusted-issuer list with the OIDC subjects of the GitHub
   Actions workflow(s) that publish official Rensei plugins:
   ```
   https://github.com/RenseiAI/donmai-libraries/.github/workflows/plugin-sign.yml@refs/heads/main
   https://github.com/RenseiAI/donmai-libraries/.github/workflows/plugin-sign.yml@refs/tags/plugin-vercel-v*
   ```
2. Add any long-lived publisher DIDs used for non-OIDC channels:
   ```
   did:web:rensei.dev
   ```
3. Ship that list via `setTrustedIssuerSet({ mode: 'production', ... })`
   in the host's startup code (`packages/cli/src/setup.ts` or equivalent).
4. Set `trustMode: 'strict'` once the set is populated and validated.

The placeholder set is intentionally empty so that an operator who
forgets step 3 and still flips strict mode on gets a *loud rejection of
all signed plugins* rather than silent acceptance.

## CI workflow lifecycle

```
git tag plugin-vercel-v1.4.0          (or push a Release)
        │
        ▼
.github/workflows/plugin-sign.yml triggers
        │
        ├── pnpm pack → artifacts/rensei-plugin-vercel-1.4.0.tgz
        │
        ├── cosign sign-blob (keyless OIDC)
        │     ├── requests Fulcio cert (subject = workflow URI)
        │     ├── signs the tarball SHA
        │     └── pushes Rekor entry
        │
        ├── cosign verify-blob (sanity check)
        │
        ├── upload-artifact (always)
        │
        └── gh release upload (if tag/release)
              tarball + tarball.sigstore.json bundle
```

Hosts that pull the released tarball verify the sigstore bundle on load:

```
loader.installPlugin(manifest)
  │
  ├── validatePluginManifest (schema, namespace)
  │
  ├── verifyPluginSignature (manifest hash + algorithm dispatch)
  │     └── SigstoreVerifier.verify (bundle → @sigstore/verify)
  │
  ├── checkTrustedIssuer
  │     └── strict: signer must be in trusted-issuer set
  │
  └── installed
```

## Smoke test

`packages/core/src/plugins/sigstore-signing.test.ts` covers the
end-to-end loader integration including a deliberately tampered plugin
manifest. Under both `strict` and `permissive` modes, mutating the
manifest after signing causes the load to fail at the manifest-hash
gate before the trust check is reached.

Run:

```sh
pnpm --filter @donmai/core test -- sigstore-signing
```

## Activation checklist

For a fully active default-signed posture the user must:

- [ ] Provision the GitHub org secrets listed above (most are optional —
      defaults work for the public Sigstore deployment).
- [ ] Populate the trusted-issuer set with the real Rensei OIDC subjects
      and any long-lived publisher DIDs (see *Trusted issuer set* above).
      Replace `PLACEHOLDER_TRUSTED_ISSUERS` at host startup via
      `setTrustedIssuerSet({ mode: 'production', ... })`.
- [ ] Tag a plugin release in the form `plugin-<name>-v<semver>` and
      verify `plugin-sign.yml` produces a Rekor entry + a
      `*.sigstore.json` bundle attached to the GitHub Release.
- [ ] Flip the host loader to `trustMode: 'strict'` +
      `requireSignatures: true` once the trusted-issuer set is
      populated and end-to-end signing has been validated.
- [ ] Document the activation date in `runs/STATUS.md` and close the
      tracking issue.

Until those steps are completed the platform behaves exactly as before
(`permissive` mode, unsigned plugins accepted with a warning) — the
scaffolding is inert until the operator turns it on.
