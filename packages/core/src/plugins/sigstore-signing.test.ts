/**
 * Sigstore Signing CI — productionization smoke tests (REN-1344)
 *
 * Coverage:
 *   1. Trusted-issuer set bootstrap (placeholder + override).
 *   2. Trust mode gating (`permissive` warns, `strict` rejects).
 *   3. Smoke test: a deliberately-tampered plugin tarball / manifest fails
 *      verification under strict mode.
 *
 * Architecture references:
 *   - rensei-architecture/015-plugin-spec.md §Auth + trust
 *   - rensei-architecture/002-provider-base-contract.md §Signing and trust
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { PluginLoader } from './loader.js'
import { PluginRegistry, setDefaultRegistry } from './registry.js'
import { hashPluginManifest } from './manifest.js'
import {
  setTrustedIssuerSet,
  getTrustedIssuerSet,
  resetTrustedIssuerSet,
  checkTrustedIssuer,
  PLACEHOLDER_TRUSTED_ISSUERS,
  type TrustedIssuerSet,
} from './trusted-issuers.js'
import type { PluginManifest } from './manifest.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRUSTED_SUBJECT =
  'https://github.com/RenseiAI/donmai-libraries/.github/workflows/plugin-sign.yml@refs/heads/main'

const RENSEI_TRUSTED_SET: TrustedIssuerSet = {
  mode: 'production',
  issuers: [
    {
      name: 'Rensei Plugin Sign Workflow',
      subject: TRUSTED_SUBJECT,
      algorithms: ['sigstore'],
      notes: 'GitHub Actions OIDC for plugins built from the Rensei monorepo',
    },
    {
      name: 'Rensei Plugin DID',
      subject: 'did:web:rensei.dev',
      algorithms: ['ed25519'],
    },
  ],
}

function makeManifest(
  id: string,
  overrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    apiVersion: 'rensei.dev/v1',
    kind: 'Plugin',
    metadata: {
      id,
      name: `Test ${id}`,
      version: '1.0.0',
    },
    engines: { rensei: '>=0.9' },
    ...overrides,
  } as PluginManifest
}

function makeSignedManifest(
  id: string,
  signer: string,
  algorithm: 'sigstore' | 'cosign' | 'ed25519' | 'minisign' = 'sigstore',
  signatureValue = 'SIGSTORE_TEST:bundle-bytes',
): PluginManifest {
  const base = makeManifest(id)
  const expectedHash = hashPluginManifest(base)
  return {
    ...base,
    signature: {
      signer,
      publicKey: '', // keyless under sigstore
      algorithm,
      signatureValue,
      manifestHash: expectedHash,
      attestedAt: '2026-04-28T00:00:00.000Z',
    },
  }
}

// Compute a simple sha256 of bytes — used to simulate the tarball-content
// hash that a real CI signing pipeline would feed into Sigstore.
function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// ---------------------------------------------------------------------------
// 1. Trusted-issuer set bootstrap
// ---------------------------------------------------------------------------

describe('trusted-issuer set bootstrap', () => {
  afterEach(() => {
    resetTrustedIssuerSet()
  })

  it('ships an empty placeholder set by default', () => {
    expect(PLACEHOLDER_TRUSTED_ISSUERS.mode).toBe('placeholder')
    expect(PLACEHOLDER_TRUSTED_ISSUERS.issuers).toEqual([])
  })

  it('setTrustedIssuerSet replaces the active set', () => {
    setTrustedIssuerSet(RENSEI_TRUSTED_SET)
    const active = getTrustedIssuerSet()
    expect(active.mode).toBe('production')
    expect(active.issuers).toHaveLength(2)
    expect(active.issuers.map((i) => i.subject)).toContain(TRUSTED_SUBJECT)
  })

  it('resetTrustedIssuerSet returns to the placeholder', () => {
    setTrustedIssuerSet(RENSEI_TRUSTED_SET)
    resetTrustedIssuerSet()
    expect(getTrustedIssuerSet().mode).toBe('placeholder')
  })

  it('getTrustedIssuerSet returns a defensive copy of the issuer list', () => {
    setTrustedIssuerSet(RENSEI_TRUSTED_SET)
    const a = getTrustedIssuerSet()
    a.issuers.push({ name: 'evil', subject: 'evil', algorithms: [] })
    const b = getTrustedIssuerSet()
    expect(b.issuers).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 2. checkTrustedIssuer — pure function
// ---------------------------------------------------------------------------

describe('checkTrustedIssuer', () => {
  it('permissive: unsigned plugin is trusted', () => {
    const m = makeManifest('foo')
    const r = checkTrustedIssuer(m, {
      trustMode: 'permissive',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    expect(r.trusted).toBe(true)
  })

  it('strict: unsigned plugin is rejected', () => {
    const m = makeManifest('foo')
    const r = checkTrustedIssuer(m, {
      trustMode: 'strict',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    expect(r.trusted).toBe(false)
    expect(r.reason).toMatch(/strict trust mode requires a signature/)
  })

  it('permissive: signed by trusted issuer matches', () => {
    const m = makeSignedManifest('foo', TRUSTED_SUBJECT)
    const r = checkTrustedIssuer(m, {
      trustMode: 'permissive',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    expect(r.trusted).toBe(true)
    expect(r.matchedIssuer?.name).toBe('Rensei Plugin Sign Workflow')
  })

  it('strict: signed by trusted issuer matches', () => {
    const m = makeSignedManifest('foo', TRUSTED_SUBJECT)
    const r = checkTrustedIssuer(m, {
      trustMode: 'strict',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    expect(r.trusted).toBe(true)
  })

  it('permissive: signed by unknown issuer warns but accepts', () => {
    const m = makeSignedManifest('foo', 'https://github.com/evil/repo')
    const r = checkTrustedIssuer(m, {
      trustMode: 'permissive',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    expect(r.trusted).toBe(true)
    expect(r.matchedIssuer).toBeUndefined()
    expect(r.reason).toMatch(/not in the trusted-issuer set/)
  })

  it('strict: signed by unknown issuer is rejected', () => {
    const m = makeSignedManifest('foo', 'https://github.com/evil/repo')
    const r = checkTrustedIssuer(m, {
      trustMode: 'strict',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    expect(r.trusted).toBe(false)
    expect(r.reason).toMatch(/not in the trusted-issuer set/)
  })

  it('strict: matching subject but wrong algorithm is rejected', () => {
    // Trusted set declares ed25519 for this subject
    const m = makeSignedManifest('foo', 'did:web:rensei.dev', 'sigstore')
    const r = checkTrustedIssuer(m, {
      trustMode: 'strict',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    expect(r.trusted).toBe(false)
  })

  it('permissive + placeholder set: hint mentions the placeholder', () => {
    const m = makeSignedManifest('foo', 'https://github.com/evil/repo')
    const r = checkTrustedIssuer(m, {
      trustMode: 'permissive',
      trustedIssuers: PLACEHOLDER_TRUSTED_ISSUERS,
    })
    expect(r.trusted).toBe(true)
    expect(r.reason).toMatch(/placeholder/)
  })

  it('strict + placeholder set: error mentions the placeholder', () => {
    const m = makeSignedManifest('foo', 'https://github.com/evil/repo')
    const r = checkTrustedIssuer(m, {
      trustMode: 'strict',
      trustedIssuers: PLACEHOLDER_TRUSTED_ISSUERS,
    })
    expect(r.trusted).toBe(false)
    expect(r.reason).toMatch(/placeholder stub/)
  })
})

// ---------------------------------------------------------------------------
// 3. Loader integration — strict mode rejects, permissive warns
// ---------------------------------------------------------------------------

describe('PluginLoader trust-mode gating (REN-1344)', () => {
  let registry: PluginRegistry

  beforeEach(() => {
    registry = new PluginRegistry()
    setDefaultRegistry(registry)
  })

  it('permissive: untrusted signed plugin is accepted with a warning', async () => {
    // Use STUB_VALID so the synchronous signature check passes; trust gate
    // is the only thing exercised here.
    const base = makeManifest('strange')
    const expectedHash = hashPluginManifest(base)
    const m: PluginManifest = {
      ...base,
      signature: {
        signer: 'https://github.com/evil/repo',
        publicKey: 'k',
        algorithm: 'ed25519',
        signatureValue: 'STUB_VALID_test',
        manifestHash: expectedHash,
        attestedAt: '2026-04-28T00:00:00.000Z',
      },
    }
    const loader = new PluginLoader({
      registry,
      trustMode: 'permissive',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    const result = await loader.installPlugin(m)
    expect(result.success).toBe(true)
    expect(result.warnings.some((w) => /not in the trusted-issuer set/.test(w))).toBe(true)
  })

  it('strict: untrusted signed plugin is rejected', async () => {
    const base = makeManifest('strange')
    const expectedHash = hashPluginManifest(base)
    const m: PluginManifest = {
      ...base,
      signature: {
        signer: 'https://github.com/evil/repo',
        publicKey: 'k',
        algorithm: 'ed25519',
        signatureValue: 'STUB_VALID_test',
        manifestHash: expectedHash,
        attestedAt: '2026-04-28T00:00:00.000Z',
      },
    }
    const loader = new PluginLoader({
      registry,
      trustMode: 'strict',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    const result = await loader.installPlugin(m)
    expect(result.success).toBe(false)
    expect(result.errors.some((e) => /Trust check failed/.test(e))).toBe(true)
  })

  it('strict: unsigned plugin is rejected loudly', async () => {
    const m = makeManifest('unsigned')
    const loader = new PluginLoader({
      registry,
      trustMode: 'strict',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    const result = await loader.installPlugin(m)
    expect(result.success).toBe(false)
    expect(
      result.errors.some((e) => /Trust check failed.*strict trust mode requires/.test(e)),
    ).toBe(true)
  })

  it('strict: signed by trusted Rensei issuer is accepted', async () => {
    const base = makeManifest('rensei-vercel')
    const expectedHash = hashPluginManifest(base)
    const m: PluginManifest = {
      ...base,
      signature: {
        signer: TRUSTED_SUBJECT,
        publicKey: '',
        algorithm: 'sigstore',
        signatureValue: 'STUB_VALID_test',
        manifestHash: expectedHash,
        attestedAt: '2026-04-28T00:00:00.000Z',
      },
    }
    const loader = new PluginLoader({
      registry,
      trustMode: 'strict',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    const result = await loader.installPlugin(m)
    expect(result.success).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('default trust mode is permissive (preserves OSS behaviour)', async () => {
    const m = makeManifest('any')
    const loader = new PluginLoader({ registry })
    const result = await loader.installPlugin(m)
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Smoke test — deliberately-tampered plugin tarball fails verification
// ---------------------------------------------------------------------------

describe('smoke: tampered plugin tarball fails strict verification (REN-1344)', () => {
  let registry: PluginRegistry

  beforeEach(() => {
    registry = new PluginRegistry()
    setDefaultRegistry(registry)
  })

  it('a tarball whose contents have been mutated post-signing fails the manifestHash gate', async () => {
    // Build a plugin manifest that represents a signed published artifact.
    // The manifestHash is computed over the canonical-JSON of the manifest
    // *minus* the signature block — see manifest.hashPluginManifest.
    const original = makeManifest('rensei-vercel', {
      providers: {
        deployment: [
          {
            id: 'rensei-vercel.deploy',
            class: './dist/deploy.js#Deploy',
            capabilities: { region: 'iad1' },
          },
        ],
      },
    })
    const signedHash = hashPluginManifest(original)

    // CI signs this hash and produces a Sigstore bundle. We model that as
    // a SIGSTORE_TEST:-prefixed signatureValue (so the verifier's bundle
    // path is exercised without requiring real Rekor lookups).
    const signed: PluginManifest = {
      ...original,
      signature: {
        signer: TRUSTED_SUBJECT,
        publicKey: '',
        algorithm: 'sigstore',
        signatureValue: `SIGSTORE_TEST:${sha256Hex(signedHash)}`,
        manifestHash: signedHash,
        attestedAt: '2026-04-28T00:00:00.000Z',
      },
    }

    // --- Sanity: the original signed artifact installs cleanly under strict.
    const goodLoader = new PluginLoader({
      registry: new PluginRegistry(),
      trustMode: 'strict',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    const goodResult = await goodLoader.installPlugin(signed)
    expect(goodResult.success).toBe(true)

    // --- Now tamper. Adversary swaps the deploy capability after signing.
    // (Imagine a post-publication MITM mutating the tarball.)
    const tampered: PluginManifest = {
      ...signed,
      providers: {
        deployment: [
          {
            id: 'rensei-vercel.deploy',
            class: './dist/deploy.js#Deploy',
            capabilities: { region: 'attacker-controlled' },
          },
        ],
      },
      // Adversary leaves the signature untouched, since they do not have
      // the Fulcio cert / Rekor entry for the new content.
    }

    const badLoader = new PluginLoader({
      registry,
      trustMode: 'strict',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    const badResult = await badLoader.installPlugin(tampered)

    // Verification must fail loudly — manifestHash drift is detected at
    // the signature stage and the plugin never lands in the registry.
    expect(badResult.success).toBe(false)
    expect(
      badResult.errors.some(
        (e) =>
          /manifestHash mismatch/i.test(e) ||
          /signature/i.test(e) ||
          /Signature verification failed/i.test(e),
      ),
    ).toBe(true)
    expect(registry.getPlugin('rensei-vercel')).toBeUndefined()
  })

  it('a tampered tarball under permissive mode still fails the hash gate', async () => {
    // The signature gate runs before the trust gate, so even permissive
    // mode rejects post-signing content drift. This protects downgrade
    // attacks where an operator flips to permissive expecting "warn-only".
    const original = makeManifest('honest-plugin')
    const signedHash = hashPluginManifest(original)
    const signed: PluginManifest = {
      ...original,
      signature: {
        signer: TRUSTED_SUBJECT,
        publicKey: '',
        algorithm: 'sigstore',
        signatureValue: 'STUB_VALID_test',
        manifestHash: signedHash,
        attestedAt: '2026-04-28T00:00:00.000Z',
      },
    }
    const tampered: PluginManifest = {
      ...signed,
      metadata: { ...signed.metadata, version: '99.99.99' },
    }
    const loader = new PluginLoader({
      registry,
      trustMode: 'permissive',
      trustedIssuers: RENSEI_TRUSTED_SET,
    })
    const result = await loader.installPlugin(tampered)
    expect(result.success).toBe(false)
    expect(
      result.errors.some(
        (e) => /manifestHash mismatch/i.test(e) || /signature/i.test(e),
      ),
    ).toBe(true)
  })
})
