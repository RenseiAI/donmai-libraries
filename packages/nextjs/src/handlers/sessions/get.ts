/**
 * GET /api/sessions/[id]
 * Returns a single agent session by ID
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionState, type AgentSessionState, createLogger } from '@donmai/server'
import type { AgentSessionResponse } from './list.js'

const log = createLogger('api:sessions:[id]')

interface RouteParams {
  params: Promise<{ id: string }>
}

function toResponse(session: AgentSessionState): AgentSessionResponse {
  return {
    id: session.trackerSessionId,
    trackerSessionId: session.trackerSessionId,
    linearSessionId: session.trackerSessionId,
    issueId: session.issueId,
    identifier: session.issueIdentifier || session.issueId.slice(0, 8),
    providerSessionId: session.providerSessionId || undefined,
    provider: session.provider || undefined,
    status: session.status,
    createdAt: new Date(session.createdAt * 1000).toISOString(),
    updatedAt: new Date(session.updatedAt * 1000).toISOString(),
    worktreePath: session.worktreePath,
    workerId: session.workerId || undefined,
    queuedAt: session.queuedAt
      ? new Date(session.queuedAt).toISOString()
      : undefined,
    claimedAt: session.claimedAt
      ? new Date(session.claimedAt * 1000).toISOString()
      : undefined,
    agentId: session.agentId || undefined,
  }
}

export function createSessionGetHandler() {
  return async function GET(_request: NextRequest, { params }: RouteParams) {
    const { id: sessionId } = await params

    try {
      const session = await getSessionState(sessionId)

      if (!session) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Session not found' },
          { status: 404 }
        )
      }

      return NextResponse.json({
        session: toResponse(session),
      })
    } catch (error) {
      log.error('Failed to fetch session', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to fetch session' },
        { status: 500 }
      )
    }
  }
}
