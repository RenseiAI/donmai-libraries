/**
 * POST /api/sessions/[id]/progress
 *
 * Post a progress update as an agent activity to Linear.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { getSessionState, createLogger } from '@renseiai/agentfactory-server'
import type { RouteConfig } from '../../types.js'
import { storeActivity } from './activity-store.js'

const log = createLogger('api:sessions:progress')

interface RouteParams {
  params: Promise<{ id: string }>
}

const MILESTONE_EMOJI: Record<string, string> = {
  claimed: '\u{1f527}',
  worktree: '\u{1f4c2}',
  started: '\u{1f916}',
  running: '\u23f3',
  tests: '\u{1f9ea}',
  pr: '\u{1f500}',
  completed: '\u2705',
  failed: '\u274c',
  stopped: '\u{1f6d1}',
  resumed: '\u{1f504}',
}

export function createSessionProgressHandler(config: RouteConfig) {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = await request.json()
      const { workerId, milestone, message } = body as {
        workerId: string
        milestone?: string
        message: string
      }

      if (!workerId || typeof workerId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'workerId is required' },
          { status: 400 }
        )
      }

      if (!message || typeof message !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'message is required' },
          { status: 400 }
        )
      }

      const session = await getSessionState(sessionId)
      if (!session) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Session not found' },
          { status: 404 }
        )
      }

      if (session.workerId && session.workerId !== workerId) {
        return NextResponse.json(
          { error: 'Forbidden', message: 'Session is owned by another worker' },
          { status: 403 }
        )
      }

      // Store progress as activity for TUI streaming
      storeActivity(sessionId, {
        type: 'progress',
        content: message,
        timestamp: new Date().toISOString(),
      })

      // Skip Linear forwarding when no real Linear session exists.
      // Governor-generated sessions (prefixed "governor-") have no Linear
      // counterpart. When providerSessionId is set (from platform workflow
      // dispatch), it overrides the session key for this check.
      const effectiveSessionId = session.providerSessionId ?? sessionId
      if (effectiveSessionId.startsWith('governor-')) {
        log.debug('Skipping Linear progress post for governor-generated session', {
          sessionId,
          milestone,
        })
        return NextResponse.json({
          posted: false,
          reason: 'Governor-generated session — no Linear agent session exists',
        })
      }

      const emoji = milestone ? MILESTONE_EMOJI[milestone] || '\u2139\ufe0f' : ''
      const formattedMessage = emoji ? `${emoji} ${message}` : message

      try {
        const linearClient = await config.linearClient.getClient(session.organizationId)

        await linearClient.createAgentActivity({
          agentSessionId: session.trackerSessionId,
          content: { type: 'response', body: formattedMessage },
          ephemeral: false,
        })

        log.info('Progress activity posted', {
          sessionId,
          trackerSessionId: session.trackerSessionId,
          milestone,
          messageLength: message.length,
        })

        return NextResponse.json({
          posted: true,
          milestone,
        })
      } catch (linearError) {
        const errorMessage = linearError instanceof Error ? linearError.message : String(linearError)
        log.error('Failed to post progress activity to Linear', {
          error: errorMessage,
          sessionId,
          trackerSessionId: session.trackerSessionId,
          milestone,
        })
        return NextResponse.json({
          posted: false,
          reason: `Failed to post to Linear: ${errorMessage}`,
        })
      }
    } catch (error) {
      log.error('Failed to process progress update', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to process progress update' },
        { status: 500 }
      )
    }
  }
}
