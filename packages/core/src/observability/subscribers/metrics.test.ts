/**
 * Tests for the metrics subscriber.
 *
 * Coverage:
 * - NoopMetricsBackend (baseline)
 * - PrometheusTextBackend counter / histogram / gauge
 * - PrometheusTextBackend.getPrometheusText() format
 * - registerMetricsSubscriber — fires backend calls on each event kind
 * - Unsubscribe stops delivery
 */

import { describe, it, expect, vi } from 'vitest'
import { HookBus } from '../hooks.js'
import {
  NoopMetricsBackend,
  PrometheusTextBackend,
  registerMetricsSubscriber,
} from './metrics.js'
import type { MetricsBackend, MetricLabels } from './metrics.js'
import type { ProviderRef } from '../../providers/base.js'

function makeRef(id = 'test-provider'): ProviderRef {
  return { id, family: 'sandbox', version: '1.0.0' }
}

// ---------------------------------------------------------------------------
// NoopMetricsBackend
// ---------------------------------------------------------------------------

describe('NoopMetricsBackend', () => {
  it('counter does not throw', () => {
    const b = new NoopMetricsBackend()
    expect(() => b.counter('foo', { a: 'b' }, 1)).not.toThrow()
  })

  it('histogram does not throw', () => {
    const b = new NoopMetricsBackend()
    expect(() => b.histogram('foo', { a: 'b' }, 100)).not.toThrow()
  })

  it('gauge does not throw', () => {
    const b = new NoopMetricsBackend()
    expect(() => b.gauge('foo', { a: 'b' }, 42)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// PrometheusTextBackend
// ---------------------------------------------------------------------------

describe('PrometheusTextBackend counter', () => {
  it('increments counter and emits total', () => {
    const b = new PrometheusTextBackend()
    b.counter('requests', { path: '/health' })
    b.counter('requests', { path: '/health' })
    const text = b.getPrometheusText()
    expect(text).toContain('requests_total{path="/health"} 2')
  })

  it('handles multiple label sets independently', () => {
    const b = new PrometheusTextBackend()
    b.counter('requests', { path: '/a' })
    b.counter('requests', { path: '/b' })
    const text = b.getPrometheusText()
    expect(text).toContain('requests_total{path="/a"} 1')
    expect(text).toContain('requests_total{path="/b"} 1')
  })

  it('value defaults to 1 when not specified', () => {
    const b = new PrometheusTextBackend()
    b.counter('hits', {})
    const text = b.getPrometheusText()
    expect(text).toContain('hits_total 1')
  })

  it('value can be incremented by custom amount', () => {
    const b = new PrometheusTextBackend()
    b.counter('bytes', {}, 1024)
    const text = b.getPrometheusText()
    expect(text).toContain('bytes_total 1024')
  })

  it('reset() clears all metrics', () => {
    const b = new PrometheusTextBackend()
    b.counter('hits', {})
    b.reset()
    expect(b.getPrometheusText()).toBe('')
  })
})

describe('PrometheusTextBackend gauge', () => {
  it('sets gauge to the given value', () => {
    const b = new PrometheusTextBackend()
    b.gauge('queue_depth', { queue: 'main' }, 42)
    const text = b.getPrometheusText()
    expect(text).toContain('queue_depth{queue="main"} 42')
  })

  it('overwrites the gauge on second call', () => {
    const b = new PrometheusTextBackend()
    b.gauge('queue_depth', {}, 10)
    b.gauge('queue_depth', {}, 20)
    const text = b.getPrometheusText()
    expect(text).toContain('queue_depth 20')
    expect(text).not.toContain('queue_depth 10')
  })
})

describe('PrometheusTextBackend histogram', () => {
  it('records sum and count', () => {
    const b = new PrometheusTextBackend()
    b.histogram('duration_ms', { op: 'activate' }, 100)
    b.histogram('duration_ms', { op: 'activate' }, 200)
    const text = b.getPrometheusText()
    expect(text).toContain('duration_ms_sum{op="activate"} 300')
    expect(text).toContain('duration_ms_count{op="activate"} 2')
  })

  it('increments the correct buckets', () => {
    const b = new PrometheusTextBackend([10, 50, 100, Infinity])
    b.histogram('latency', {}, 30) // falls in 50 and 100 and +Inf buckets
    const text = b.getPrometheusText()
    expect(text).toContain('latency_bucket{le="10"} 0')
    expect(text).toContain('latency_bucket{le="50"} 1')
    expect(text).toContain('latency_bucket{le="100"} 1')
    expect(text).toContain('latency_bucket{le="+Inf"} 1')
  })

  it('adds +Inf bucket automatically if not provided', () => {
    const b = new PrometheusTextBackend([10, 50, 100]) // no Infinity
    b.histogram('latency', {}, 200) // exceeds all buckets except +Inf
    const text = b.getPrometheusText()
    expect(text).toContain('latency_bucket{le="+Inf"} 1')
  })
})

// ---------------------------------------------------------------------------
// registerMetricsSubscriber
// ---------------------------------------------------------------------------

describe('registerMetricsSubscriber', () => {
  it('fires counter on pre-activate', async () => {
    const bus = new HookBus()
    const calls: Array<[string, MetricLabels, number | undefined]> = []
    const mockBackend: MetricsBackend = {
      counter: (name, labels, value) => { calls.push([name, labels, value]) },
      histogram: () => {},
      gauge: () => {},
    }

    registerMetricsSubscriber(bus, { backend: mockBackend })
    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    expect(calls.some(([name]) => name.includes('activations_started'))).toBe(true)
  })

  it('fires counter + histogram on post-activate', async () => {
    const bus = new HookBus()
    const counters: string[] = []
    const histograms: string[] = []
    const mockBackend: MetricsBackend = {
      counter: (name) => { counters.push(name) },
      histogram: (name) => { histograms.push(name) },
      gauge: () => {},
    }

    registerMetricsSubscriber(bus, { backend: mockBackend })
    await bus.emit({ kind: 'post-activate', provider: makeRef(), durationMs: 50 })

    expect(counters.some((n) => n.includes('activations_completed'))).toBe(true)
    expect(histograms.some((n) => n.includes('activation_duration_ms'))).toBe(true)
  })

  it('fires counter on verb-error', async () => {
    const bus = new HookBus()
    const counters: string[] = []
    const mockBackend: MetricsBackend = {
      counter: (name) => { counters.push(name) },
      histogram: () => {},
      gauge: () => {},
    }

    registerMetricsSubscriber(bus, { backend: mockBackend })
    await bus.emit({ kind: 'verb-error', provider: makeRef(), verb: 'provision', error: new Error('fail') })

    expect(counters.some((n) => n.includes('verb_errors'))).toBe(true)
  })

  it('fires tool_uses_started counter on pre-tool-use', async () => {
    const bus = new HookBus()
    const counters: Array<[string, MetricLabels]> = []
    const mockBackend: MetricsBackend = {
      counter: (name, labels) => { counters.push([name, labels]) },
      histogram: () => {},
      gauge: () => {},
    }

    registerMetricsSubscriber(bus, { backend: mockBackend })
    await bus.emit({
      kind: 'pre-tool-use',
      provider: { id: 'claude', family: 'agent-runtime', version: 'v1' },
      sessionId: 'sess_42',
      toolUseId: 'tu_1',
      toolName: 'Bash',
      toolInput: {},
      toolCategory: 'general',
    })

    const hit = counters.find(([n]) => n.includes('tool_uses_started'))
    expect(hit).toBeDefined()
    expect(hit?.[1]).toMatchObject({ tool_name: 'Bash', tool_category: 'general' })
  })

  it('fires tool_uses_completed counter + duration histogram on post-tool-use', async () => {
    const bus = new HookBus()
    const counters: Array<[string, MetricLabels]> = []
    const histograms: Array<[string, MetricLabels, number]> = []
    const mockBackend: MetricsBackend = {
      counter: (name, labels) => { counters.push([name, labels]) },
      histogram: (name, labels, value) => { histograms.push([name, labels, value]) },
      gauge: () => {},
    }

    registerMetricsSubscriber(bus, { backend: mockBackend })
    await bus.emit({
      kind: 'post-tool-use',
      provider: { id: 'claude', family: 'agent-runtime', version: 'v1' },
      sessionId: 'sess_42',
      toolUseId: 'tu_1',
      toolName: 'Read',
      toolOutput: 'ok',
      durationMs: 17,
      isError: false,
    })

    expect(counters.some(([n]) => n.includes('tool_uses_completed'))).toBe(true)
    const histHit = histograms.find(([n]) => n.includes('tool_use_duration_ms'))
    expect(histHit?.[2]).toBe(17)
  })

  it('fires tool_use_errors counter on tool-use-error', async () => {
    const bus = new HookBus()
    const counters: string[] = []
    const mockBackend: MetricsBackend = {
      counter: (name) => { counters.push(name) },
      histogram: () => {},
      gauge: () => {},
    }

    registerMetricsSubscriber(bus, { backend: mockBackend })
    await bus.emit({
      kind: 'tool-use-error',
      provider: { id: 'claude', family: 'agent-runtime', version: 'v1' },
      sessionId: 'sess_42',
      toolUseId: 'tu_2',
      toolName: 'Bash',
      error: 'permission denied',
    })

    expect(counters.some((n) => n.includes('tool_use_errors'))).toBe(true)
  })

  it('fires gauge on scope-resolved', async () => {
    const bus = new HookBus()
    const gauges: Array<[string, MetricLabels, number]> = []
    const mockBackend: MetricsBackend = {
      counter: () => {},
      histogram: () => {},
      gauge: (name, labels, value) => { gauges.push([name, labels, value]) },
    }

    registerMetricsSubscriber(bus, { backend: mockBackend })
    await bus.emit({
      kind: 'scope-resolved',
      chosen: [makeRef('a'), makeRef('b')],
      rejected: [{ provider: makeRef('c'), reason: 'shadowed' }],
    })

    const chosenGauge = gauges.find(([n]) => n.includes('chosen_count'))
    const rejectedGauge = gauges.find(([n]) => n.includes('rejected_count'))
    expect(chosenGauge?.[2]).toBe(2)
    expect(rejectedGauge?.[2]).toBe(1)
  })

  it('uses custom prefix', async () => {
    const bus = new HookBus()
    const names: string[] = []
    const mockBackend: MetricsBackend = {
      counter: (name) => { names.push(name) },
      histogram: () => {},
      gauge: () => {},
    }

    registerMetricsSubscriber(bus, { backend: mockBackend, prefix: 'my_custom' })
    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    expect(names.every((n) => n.startsWith('my_custom'))).toBe(true)
  })

  it('unsubscribe stops delivery', async () => {
    const bus = new HookBus()
    const calls: string[] = []
    const mockBackend: MetricsBackend = {
      counter: (name) => { calls.push(name) },
      histogram: () => {},
      gauge: () => {},
    }

    const unsubscribe = registerMetricsSubscriber(bus, { backend: mockBackend })
    await bus.emit({ kind: 'pre-activate', provider: makeRef() })
    unsubscribe()
    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    const preActivateCalls = calls.filter((n) => n.includes('activations_started'))
    expect(preActivateCalls).toHaveLength(1)
  })

  it('NoopMetricsBackend is used when no backend is specified', async () => {
    const bus = new HookBus()
    // Should not throw
    const unsubscribe = registerMetricsSubscriber(bus)
    await expect(bus.emit({ kind: 'pre-activate', provider: makeRef() })).resolves.toBeUndefined()
    unsubscribe()
  })

  it('fires metrics for all 12 event kinds without errors', async () => {
    const bus = new HookBus()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const b = new PrometheusTextBackend()
    registerMetricsSubscriber(bus, { backend: b })

    const runtimeRef: ProviderRef = { id: 'claude', family: 'agent-runtime', version: 'v1' }
    await bus.emit({ kind: 'pre-activate', provider: makeRef() })
    await bus.emit({ kind: 'post-activate', provider: makeRef(), durationMs: 10 })
    await bus.emit({ kind: 'pre-deactivate', provider: makeRef(), reason: 'test' })
    await bus.emit({ kind: 'post-deactivate', provider: makeRef() })
    await bus.emit({ kind: 'pre-verb', provider: makeRef(), verb: 'v', args: {} })
    await bus.emit({ kind: 'post-verb', provider: makeRef(), verb: 'v', result: {}, durationMs: 5 })
    await bus.emit({ kind: 'verb-error', provider: makeRef(), verb: 'v', error: new Error('e') })
    await bus.emit({ kind: 'pre-tool-use', provider: runtimeRef, sessionId: 'sess_1', toolUseId: 'tu_1', toolName: 'Read', toolInput: {} })
    await bus.emit({ kind: 'post-tool-use', provider: runtimeRef, sessionId: 'sess_1', toolUseId: 'tu_1', toolName: 'Read', toolOutput: '', durationMs: 7, isError: false })
    await bus.emit({ kind: 'tool-use-error', provider: runtimeRef, sessionId: 'sess_1', toolUseId: 'tu_2', toolName: 'Bash', error: 'denied' })
    await bus.emit({ kind: 'capability-mismatch', provider: makeRef(), declared: {}, observed: {} })
    await bus.emit({ kind: 'scope-resolved', chosen: [], rejected: [] })

    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
