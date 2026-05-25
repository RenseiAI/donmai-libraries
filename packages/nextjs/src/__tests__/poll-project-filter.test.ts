import { describe, it, expect } from 'vitest'
import type { QueuedWork } from '@donmai/server'

/**
 * Tests for project-based work filtering in the poll handler.
 *
 * The poll handler filters work items based on the worker's `projects` field.
 * This test validates the filtering logic independently of Redis/HTTP.
 */

function filterWorkForProjects(
  allWork: QueuedWork[],
  workerProjects: string[] | undefined,
  desiredCount: number,
): QueuedWork[] {
  const hasProjectFilter = workerProjects && workerProjects.length > 0

  if (hasProjectFilter) {
    // Accept: matching project OR untagged items (backward compat)
    return allWork
      .filter(w => !w.projectName || workerProjects.includes(w.projectName))
      .slice(0, desiredCount)
  }
  return allWork.slice(0, desiredCount)
}

function makeWork(overrides: Partial<QueuedWork> = {}): QueuedWork {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    issueId: 'issue-1',
    issueIdentifier: 'TEST-1',
    priority: 3,
    queuedAt: Date.now(),
    ...overrides,
  }
}

describe('poll handler project filtering', () => {
  it('worker with projects: ["Social"] receives only Social + untagged work', () => {
    const allWork = [
      makeWork({ projectName: 'Social', issueIdentifier: 'SUP-1' }),
      makeWork({ projectName: 'Agent', issueIdentifier: 'SUP-2' }),
      makeWork({ projectName: undefined, issueIdentifier: 'SUP-3' }),
      makeWork({ projectName: 'Art', issueIdentifier: 'SUP-4' }),
    ]

    const result = filterWorkForProjects(allWork, ['Social'], 5)

    expect(result).toHaveLength(2)
    expect(result[0].issueIdentifier).toBe('SUP-1')
    expect(result[1].issueIdentifier).toBe('SUP-3')
  })

  it('worker with projects: undefined receives all work', () => {
    const allWork = [
      makeWork({ projectName: 'Social' }),
      makeWork({ projectName: 'Agent' }),
      makeWork({ projectName: undefined }),
    ]

    const result = filterWorkForProjects(allWork, undefined, 5)

    expect(result).toHaveLength(3)
  })

  it('worker with projects: ["Social", "Agent"] receives both + untagged', () => {
    const allWork = [
      makeWork({ projectName: 'Social', issueIdentifier: 'SUP-1' }),
      makeWork({ projectName: 'Agent', issueIdentifier: 'SUP-2' }),
      makeWork({ projectName: 'Art', issueIdentifier: 'SUP-3' }),
      makeWork({ projectName: undefined, issueIdentifier: 'SUP-4' }),
    ]

    const result = filterWorkForProjects(allWork, ['Social', 'Agent'], 5)

    expect(result).toHaveLength(3)
    expect(result.map(w => w.issueIdentifier)).toEqual(['SUP-1', 'SUP-2', 'SUP-4'])
  })

  it('empty queue returns empty regardless of filter', () => {
    expect(filterWorkForProjects([], ['Social'], 5)).toEqual([])
    expect(filterWorkForProjects([], undefined, 5)).toEqual([])
  })

  it('respects desiredCount limit', () => {
    const allWork = [
      makeWork({ projectName: 'Social' }),
      makeWork({ projectName: 'Social' }),
      makeWork({ projectName: 'Social' }),
      makeWork({ projectName: 'Social' }),
    ]

    const result = filterWorkForProjects(allWork, ['Social'], 2)

    expect(result).toHaveLength(2)
  })

  it('empty projects array is treated as no filter', () => {
    const allWork = [
      makeWork({ projectName: 'Social' }),
      makeWork({ projectName: 'Agent' }),
    ]

    const result = filterWorkForProjects(allWork, [], 5)

    expect(result).toHaveLength(2)
  })
})
