/**
 * GET, POST /api/sessions/[id]/prompts
 *
 * DEPRECATED: Replaced by agent inbox streams (readInbox/ack).
 * These endpoints return 410 Gone to signal callers to migrate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { createLogger } from '@donmai/server'

const log = createLogger('api:sessions:prompts')

interface RouteParams {
  params: Promise<{ id: string }>
}

export function createSessionPromptsGetHandler() {
  return async function GET(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params
    log.warn('Deprecated prompts GET endpoint called', { sessionId })

    return NextResponse.json(
      {
        error: 'Gone',
        message: 'Pending prompts endpoint is deprecated. Use agent inbox streams via poll response.',
      },
      { status: 410 }
    )
  }
}

export function createSessionPromptsPostHandler() {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params
    log.warn('Deprecated prompts POST endpoint called', { sessionId })

    return NextResponse.json(
      {
        error: 'Gone',
        message: 'Prompt claiming is deprecated. Use /api/sessions/{id}/inbox/ack instead.',
      },
      { status: 410 }
    )
  }
}
