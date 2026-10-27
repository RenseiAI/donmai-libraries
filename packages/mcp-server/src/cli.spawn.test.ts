import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Spawns the compiled CLI (turbo runs build before test). Skipped if dist is absent.
const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url))

describe.skipIf(!existsSync(cli))('cli bind policy (spawned)', () => {
  const env = { ...process.env, MCP_API_KEY: '', WORKER_API_KEY: '', MCP_HOST: '', MCP_ALLOW_UNAUTHENTICATED_REMOTE: '' }

  it('exits non-zero refusing --host 0.0.0.0 without an API key', () => {
    const r = spawnSync(process.execPath, [cli, '--host', '0.0.0.0', '--port', '0'], {
      env,
      encoding: 'utf8',
      timeout: 15000,
    })
    expect(r.status).not.toBe(0)
    expect(`${r.stderr}${r.stdout}`).toMatch(/Refusing/)
  })
})
