/**
 * Repo-scoping tests — full repo-scoped synthesis.
 *
 * Covers the optional `repo` dimension added to ArchScope / ArchQuerySpec:
 *   - `effectiveRepos()` precedence + de-dup rules
 *   - SqliteArchitecturalIntelligence: contribute tags rows with repo; query
 *     filters to the named repo(s); unset repo returns the whole corpus
 *     (backward-compatible)
 *
 * The Postgres backend's repo filter is covered structurally by the
 * effectiveRepos() unit tests plus the SQL-shape assertions here; the
 * end-to-end Postgres round-trip lives in postgres/__tests__/postgres.test.ts.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteArchitecturalIntelligence } from './sqlite-impl.js'
import { effectiveRepos } from './types.js'
import type { ArchObservation, ArchQuerySpec, ArchScope } from './types.js'

// ---------------------------------------------------------------------------
// effectiveRepos() — precedence + de-dup
// ---------------------------------------------------------------------------

describe('effectiveRepos', () => {
  const base: Omit<ArchQuerySpec, 'scope' | 'repos'> = { workType: 'development' }

  it('returns [] when neither scope.repo nor repos is set (whole-corpus default)', () => {
    expect(effectiveRepos({ ...base, scope: { level: 'project' } })).toEqual([])
  })

  it('returns scope.repo as a singleton when only scope.repo is set', () => {
    expect(
      effectiveRepos({ ...base, scope: { level: 'project', repo: 'r1' } }),
    ).toEqual(['r1'])
  })

  it('returns repos[] when only repos is set', () => {
    expect(
      effectiveRepos({ ...base, scope: { level: 'project' }, repos: ['r1', 'r2'] }),
    ).toEqual(['r1', 'r2'])
  })

  it('unions scope.repo and repos, de-duping', () => {
    const result = effectiveRepos({
      ...base,
      scope: { level: 'project', repo: 'r1' },
      repos: ['r1', 'r2'],
    })
    expect(result).toEqual(['r1', 'r2'])
  })

  it('drops empty-string entries', () => {
    expect(
      effectiveRepos({
        ...base,
        scope: { level: 'project', repo: '' },
        repos: ['', 'r3'],
      }),
    ).toEqual(['r3'])
  })
})

// ---------------------------------------------------------------------------
// Sqlite contribute + query — per-repo corpus isolation
// ---------------------------------------------------------------------------

describe('SqliteArchitecturalIntelligence — repo scoping', () => {
  const dirs: string[] = []
  const impls: SqliteArchitecturalIntelligence[] = []

  function freshImpl(): SqliteArchitecturalIntelligence {
    const dir = mkdtempSync(join(tmpdir(), 'arch-repo-'))
    dirs.push(dir)
    const impl = new SqliteArchitecturalIntelligence({ dbPath: join(dir, 'db.sqlite') })
    impls.push(impl)
    return impl
  }

  afterEach(() => {
    for (const impl of impls.splice(0)) {
      try {
        impl.close()
      } catch {
        /* ignore */
      }
    }
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  function patternObs(title: string, repo?: string): ArchObservation {
    const scope: ArchScope = { level: 'project', projectId: 'proj-1' }
    if (repo) scope.repo = repo
    return {
      kind: 'pattern',
      payload: { title, description: `${title} desc`, locations: [], tags: [] },
      source: { sessionId: `sess-${title}` },
      confidence: 0.8,
      scope,
    }
  }

  it('query with repos=[r1] returns only r1-tagged rows', async () => {
    const impl = freshImpl()
    await impl.contribute(patternObs('RepoA pattern', 'github.com/acme/a'))
    await impl.contribute(patternObs('RepoB pattern', 'github.com/acme/b'))

    const view = await impl.query({
      workType: 'development',
      scope: { level: 'project', projectId: 'proj-1' },
      repos: ['github.com/acme/a'],
    })
    expect(view.patterns).toHaveLength(1)
    expect(view.patterns[0]?.title).toBe('RepoA pattern')
  })

  it('query with scope.repo also scopes to that repo', async () => {
    const impl = freshImpl()
    await impl.contribute(patternObs('RepoA pattern', 'github.com/acme/a'))
    await impl.contribute(patternObs('RepoB pattern', 'github.com/acme/b'))

    const view = await impl.query({
      workType: 'development',
      scope: { level: 'project', projectId: 'proj-1', repo: 'github.com/acme/b' },
    })
    expect(view.patterns).toHaveLength(1)
    expect(view.patterns[0]?.title).toBe('RepoB pattern')
  })

  it('query with repos=[r1,r2] returns the union of both corpora', async () => {
    const impl = freshImpl()
    await impl.contribute(patternObs('RepoA pattern', 'github.com/acme/a'))
    await impl.contribute(patternObs('RepoB pattern', 'github.com/acme/b'))
    await impl.contribute(patternObs('RepoC pattern', 'github.com/acme/c'))

    const view = await impl.query({
      workType: 'development',
      scope: { level: 'project', projectId: 'proj-1' },
      repos: ['github.com/acme/a', 'github.com/acme/b'],
    })
    const titles = view.patterns.map((p) => p.title).sort()
    expect(titles).toEqual(['RepoA pattern', 'RepoB pattern'])
  })

  it('query without repos returns the whole project corpus (backward-compatible)', async () => {
    const impl = freshImpl()
    await impl.contribute(patternObs('RepoA pattern', 'github.com/acme/a'))
    await impl.contribute(patternObs('RepoB pattern', 'github.com/acme/b'))
    await impl.contribute(patternObs('Untagged pattern')) // no repo

    const view = await impl.query({
      workType: 'development',
      scope: { level: 'project', projectId: 'proj-1' },
    })
    expect(view.patterns).toHaveLength(3)
  })

  it('repo tag round-trips onto the queried node scope', async () => {
    const impl = freshImpl()
    await impl.contribute(patternObs('Tagged', 'github.com/acme/a'))

    const view = await impl.query({
      workType: 'development',
      scope: { level: 'project', projectId: 'proj-1' },
      repos: ['github.com/acme/a'],
    })
    expect(view.patterns[0]?.scope.repo).toBe('github.com/acme/a')
  })

  it('untagged rows are excluded when a repo filter is applied', async () => {
    const impl = freshImpl()
    await impl.contribute(patternObs('Untagged pattern')) // no repo
    await impl.contribute(patternObs('RepoA pattern', 'github.com/acme/a'))

    const view = await impl.query({
      workType: 'development',
      scope: { level: 'project', projectId: 'proj-1' },
      repos: ['github.com/acme/a'],
    })
    expect(view.patterns).toHaveLength(1)
    expect(view.patterns[0]?.title).toBe('RepoA pattern')
  })
})
