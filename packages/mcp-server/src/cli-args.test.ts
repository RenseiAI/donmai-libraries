import { describe, it, expect } from 'vitest'
import { parseCliArgs } from './cli-args.js'

describe('parseCliArgs', () => {
  it('defaults to http with nothing set and no opt-in', () => {
    expect(parseCliArgs([])).toEqual({
      transport: 'http',
      port: undefined,
      host: undefined,
      allowUnauthenticatedRemote: undefined,
    })
  })

  it('passes --host through without opting in to unauthenticated remote', () => {
    const r = parseCliArgs(['--host', '0.0.0.0', '--port', '8080'])
    expect(r.host).toBe('0.0.0.0')
    expect(r.port).toBe(8080)
    expect(r.allowUnauthenticatedRemote).toBeUndefined()
  })

  it('opts in only with --allow-unauthenticated-remote', () => {
    expect(parseCliArgs(['--allow-unauthenticated-remote']).allowUnauthenticatedRemote).toBe(true)
  })

  it('selects stdio', () => {
    expect(parseCliArgs(['--stdio']).transport).toBe('stdio')
  })
})
