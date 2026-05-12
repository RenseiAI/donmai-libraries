/**
 * Tests for the session-attribution subscriber.
 *
 * Coverage:
 * - Registers and receives events
 * - Attaches SessionContext to every record
 * - Static context, function resolver
 * - requireSession=true filters events with no sessionId
 * - InMemoryAttributionSink accumulates records
 * - NoopAttributionSink discards records
 * - Custom sink integration
 * - Unsubscribe stops delivery
 */

import { describe, it, expect } from 'vitest'
import { HookBus } from '../hooks.js'
import {
  registerSessionAttributionSubscriber,
  InMemoryAttributionSink,
  NoopAttributionSink,
  readSessionContextFromEnv,
} from './session-attribution.js'
import type { HookSessionContext, AttributionRecord } from './session-attribution.js'
import type { ProviderRef } from '../../providers/base.js'

function makeRef(id = 'test-provider'): ProviderRef {
  return { id, family: 'sandbox', version: '1.0.0' }
}

const staticContext: HookSessionContext = {
  sessionId: 'sess-abc-123',
  issueId: 'REN-9999',
  workType: 'development',
  teamName: 'Agent',
}

// ---------------------------------------------------------------------------
// InMemoryAttributionSink
// ---------------------------------------------------------------------------

describe('InMemoryAttributionSink', () => {
  it('accumulates records', async () => {
    const sink = new InMemoryAttributionSink()
        sink.write({ ts: '2026-01-01T00:00:00Z', kind: 'pre-activate', session: staticContext })
    sink.write({ ts: '2026-01-01T00:00:01Z', kind: 'post-activate', session: staticContext })
    expect(sink.records).toHaveLength(2)
  })

  it('clear() removes all records', () => {
    const sink = new InMemoryAttributionSink()
    sink.write({ ts: '2026-01-01T00:00:00Z', kind: 'pre-activate', session: staticContext  })
    sink.clear()
    expect(sink.records).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// NoopAttributionSink
// ---------------------------------------------------------------------------

describe('NoopAttributionSink', () => {
  it('write does not throw', () => {
    const sink = new NoopAttributionSink()
    expect(() => sink.write({ ts: '2026-01-01T00:00:00Z', kind: 'pre-activate', session: staticContext  })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// registerSessionAttributionSubscriber
// ---------------------------------------------------------------------------

describe('registerSessionAttributionSubscriber', () => {
  it('attaches session context to each record', async () => {
    const bus = new HookBus()
    const { sink } = registerSessionAttributionSubscriber(bus, {
      context: staticContext,
    })

    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    expect((sink as InMemoryAttributionSink).records).toHaveLength(1)
    const rec = (sink as InMemoryAttributionSink).records[0]
    expect(rec.session.sessionId).toBe('sess-abc-123')
    expect(rec.session.issueId).toBe('REN-9999')
    expect(rec.session.workType).toBe('development')
  })

  it('record includes provider ref when event has one', async () => {
    const bus = new HookBus()
    const { sink } = registerSessionAttributionSubscriber(bus, { context: staticContext })

    await bus.emit({ kind: 'pre-activate', provider: makeRef('my-provider') })

    const rec = (sink as InMemoryAttributionSink).records[0]
    expect(rec.provider?.id).toBe('my-provider')
    expect(rec.provider?.family).toBe('sandbox')
  })

  it('agent-tool-use event-borne sessionId overrides static context sessionId', async () => {
    // Cross-process providers (Go daemon) emit hook events from a context
    // where the platform's env vars don't match — the event itself carries
    // the authoritative sessionId. Verify the subscriber prefers it.
    const bus = new HookBus()
    const { sink } = registerSessionAttributionSubscriber(bus, {
      context: { ...staticContext, sessionId: 'sess-from-env' },
    })

    await bus.emit({
      kind: 'post-tool-use',
      provider: { id: 'claude', family: 'runtime', version: 'v1' },
      sessionId: 'sess-from-daemon',
      toolUseId: 'tu_1',
      toolName: 'Read',
      toolOutput: 'ok',
      durationMs: 5,
      isError: false,
    })

    const rec = (sink as InMemoryAttributionSink).records[0]
    expect(rec.session.sessionId).toBe('sess-from-daemon')
    // Other session fields inherit from the static context
    expect(rec.session.issueId).toBe('REN-9999')
  })

  it('scope-resolved record has no provider field', async () => {
    const bus = new HookBus()
    const { sink } = registerSessionAttributionSubscriber(bus, { context: staticContext })

    await bus.emit({ kind: 'scope-resolved', chosen: [], rejected: [] })

    const rec = (sink as InMemoryAttributionSink).records[0]
    expect(rec.provider).toBeUndefined()
  })

  it('function resolver is called per event', async () => {
    const bus = new HookBus()
    let callCount = 0
    const resolver = (): HookSessionContext => {
      callCount++
      return { sessionId: `sess-${callCount}`, issueId: undefined, workType: undefined, teamName: undefined }
    }

    const { sink } = registerSessionAttributionSubscriber(bus, { context: resolver })

    await bus.emit({ kind: 'pre-activate', provider: makeRef() })
    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    const records = (sink as InMemoryAttributionSink).records
    expect(records[0].session.sessionId).toBe('sess-1')
    expect(records[1].session.sessionId).toBe('sess-2')
  })

  it('requireSession=true skips events when sessionId is undefined', async () => {
    const bus = new HookBus()
    const noSession: HookSessionContext = { sessionId: undefined, issueId: undefined, workType: undefined, teamName: undefined }

    const { sink } = registerSessionAttributionSubscriber(bus, {
      context: noSession,
      requireSession: true,
    })

    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    expect((sink as InMemoryAttributionSink).records).toHaveLength(0)
  })

  it('requireSession=false (default) records events even without a session', async () => {
    const bus = new HookBus()
    const noSession: HookSessionContext = { sessionId: undefined, issueId: undefined, workType: undefined, teamName: undefined }

    const { sink } = registerSessionAttributionSubscriber(bus, {
      context: noSession,
      requireSession: false,
    })

    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    expect((sink as InMemoryAttributionSink).records).toHaveLength(1)
  })

  it('custom sink receives records', async () => {
    const bus = new HookBus()
    const customRecords: AttributionRecord[] = []
    const customSink = {
      write: (r: AttributionRecord) => { customRecords.push(r) },
    }

    registerSessionAttributionSubscriber(bus, {
      context: staticContext,
      sink: customSink,
    })

    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    expect(customRecords).toHaveLength(1)
  })

  it('unsubscribe stops delivery', async () => {
    const bus = new HookBus()
    const { unsubscribe, sink } = registerSessionAttributionSubscriber(bus, { context: staticContext })

    await bus.emit({ kind: 'pre-activate', provider: makeRef() })
    unsubscribe()
    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    expect((sink as InMemoryAttributionSink).records).toHaveLength(1)
  })

  it('default sink is InMemoryAttributionSink', () => {
    const bus = new HookBus()
    const { sink } = registerSessionAttributionSubscriber(bus, { context: staticContext })
    expect(sink).toBeInstanceOf(InMemoryAttributionSink)
  })

  it('records include a valid ISO timestamp', async () => {
    const bus = new HookBus()
    const { sink } = registerSessionAttributionSubscriber(bus, { context: staticContext })

    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    const rec = (sink as InMemoryAttributionSink).records[0]
    expect(isNaN(new Date(rec.ts).getTime())).toBe(false)
  })

  it('accumulates records for all 9 event kinds', async () => {
    const bus = new HookBus()
    const { sink } = registerSessionAttributionSubscriber(bus, { context: staticContext })

    const events = [
      { kind: 'pre-activate' as const, provider: makeRef() },
      { kind: 'post-activate' as const, provider: makeRef(), durationMs: 10 },
      { kind: 'pre-deactivate' as const, provider: makeRef(), reason: 'shutdown' },
      { kind: 'post-deactivate' as const, provider: makeRef() },
      { kind: 'pre-verb' as const, provider: makeRef(), verb: 'v', args: {} },
      { kind: 'post-verb' as const, provider: makeRef(), verb: 'v', result: {}, durationMs: 5 },
      { kind: 'verb-error' as const, provider: makeRef(), verb: 'v', error: new Error('e') },
      { kind: 'capability-mismatch' as const, provider: makeRef(), declared: {}, observed: {} },
      { kind: 'scope-resolved' as const, chosen: [], rejected: [] },
    ]

    for (const ev of events) {
      await bus.emit(ev)
    }

    expect((sink as InMemoryAttributionSink).records).toHaveLength(9)
  })
})

// ---------------------------------------------------------------------------
// readSessionContextFromEnv
// ---------------------------------------------------------------------------

describe('readSessionContextFromEnv', () => {
  it('reads LINEAR_SESSION_ID from env', () => {
    process.env.LINEAR_SESSION_ID = 'test-session-id'
    const ctx = readSessionContextFromEnv()
    expect(ctx.sessionId).toBe('test-session-id')
    delete process.env.LINEAR_SESSION_ID
  })

  it('returns undefined sessionId when env var is not set', () => {
    delete process.env.LINEAR_SESSION_ID
    const ctx = readSessionContextFromEnv()
    expect(ctx.sessionId).toBeUndefined()
  })
})
