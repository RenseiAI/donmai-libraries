/**
 * POST /api/sessions/[id]/completion
 *
 * Post agent completion comment to Linear.
 * Uses multi-comment splitting for long messages.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { getSessionState, createLogger } from '@donmai/server'
import { buildCompletionComments } from '@donmai/plugin-linear'
import type { RouteConfig } from '../../types.js'

const log = createLogger('api:sessions:completion')

interface RouteParams {
  params: Promise<{ id: string }>
}

interface CompletionRequest {
  workerId?: string
  summary: string
  planItems?: Array<{
    title: string
    state: 'pending' | 'inProgress' | 'completed' | 'canceled'
  }>
}

export function createSessionCompletionHandler(config: RouteConfig) {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = (await request.json()) as CompletionRequest
      const { workerId, summary, planItems = [] } = body

      if (!summary || typeof summary !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'summary is required' },
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

      if (workerId && session.workerId && session.workerId !== workerId) {
        return NextResponse.json(
          { error: 'Forbidden', message: 'Session is owned by another worker' },
          { status: 403 }
        )
      }

      const comments = buildCompletionComments(summary, planItems, sessionId)

      log.info('Posting completion comments', {
        sessionId,
        issueId: session.issueId,
        parts: comments.length,
        summaryLength: summary.length,
      })

      const linearClient = await config.linearClient.getClient(session.organizationId)

      let postedCount = 0
      const errors: string[] = []

      for (const chunk of comments) {
        try {
          await linearClient.createComment(session.issueId, chunk.body)
          postedCount++
          log.debug(`Posted completion comment part ${chunk.partNumber}/${chunk.totalParts}`, {
            sessionId,
            issueId: session.issueId,
          })
          if (chunk.partNumber < chunk.totalParts) {
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          errors.push(`Part ${chunk.partNumber}: ${errorMsg}`)
          log.error(`Failed to post completion comment part ${chunk.partNumber}`, {
            error,
            sessionId,
            issueId: session.issueId,
          })
        }
      }

      if (postedCount === 0) {
        return NextResponse.json(
          {
            error: 'Internal Server Error',
            message: 'Failed to post any completion comments',
            errors,
          },
          { status: 500 }
        )
      }

      return NextResponse.json({
        posted: true,
        partsPosted: postedCount,
        totalParts: comments.length,
        errors: errors.length > 0 ? errors : undefined,
      })
    } catch (error) {
      log.error('Failed to process completion', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to process completion' },
        { status: 500 }
      )
    }
  }
}
