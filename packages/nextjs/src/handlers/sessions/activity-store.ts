/**
 * In-memory activity store for TUI streaming.
 * Ring buffer per session (last 200 activities).
 */
import { createLogger } from '@donmai/server'

const log = createLogger('activity-store')

export interface StoredActivity {
  id: string
  type: 'thought' | 'action' | 'response' | 'error' | 'progress' | 'context'
  content: string
  toolName?: string
  timestamp: string
  contextKey?: string
  contextValue?: unknown
}

const MAX_ACTIVITIES_PER_SESSION = 200

// sessionId -> activities array
const activityStore = new Map<string, StoredActivity[]>()
// sessionId -> next ID counter
const idCounters = new Map<string, number>()

export function storeActivity(sessionId: string, activity: Omit<StoredActivity, 'id'>): StoredActivity {
  if (!activityStore.has(sessionId)) {
    activityStore.set(sessionId, [])
    idCounters.set(sessionId, 0)
  }

  const counter = (idCounters.get(sessionId) ?? 0) + 1
  idCounters.set(sessionId, counter)

  const stored: StoredActivity = {
    ...activity,
    id: String(counter),
  }

  const activities = activityStore.get(sessionId)!
  activities.push(stored)

  // Ring buffer: trim to max
  if (activities.length > MAX_ACTIVITIES_PER_SESSION) {
    activities.splice(0, activities.length - MAX_ACTIVITIES_PER_SESSION)
  }

  return stored
}

export function getActivities(sessionId: string, afterCursor?: string): StoredActivity[] {
  const activities = activityStore.get(sessionId)
  if (!activities) return []

  if (!afterCursor) return [...activities]

  const cursorNum = parseInt(afterCursor, 10)
  if (isNaN(cursorNum)) return [...activities]

  return activities.filter(a => parseInt(a.id, 10) > cursorNum)
}

export function getLastCursor(sessionId: string): string | undefined {
  const activities = activityStore.get(sessionId)
  if (!activities || activities.length === 0) return undefined
  return activities[activities.length - 1].id
}
