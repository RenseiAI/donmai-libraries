/**
 * POST /api/workflows/deploy
 *
 * Deploy a workflow definition to the store.
 * Accepts JSON or YAML body, validates against WorkflowDefinitionSchema,
 * and persists to Redis-backed WorkflowStore.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { workflowStoreSave, createLogger } from '@donmai/server'
import { validateWorkflowDefinition } from '@donmai/core'
import { parse as parseYaml } from 'yaml'

const log = createLogger('api:workflows:deploy')

/** Duck-type check for ZodError to avoid a direct `zod` import */
function isZodError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'ZodError' &&
    Array.isArray((err as unknown as Record<string, unknown>).errors)
  )
}

/**
 * Parse the request body as JSON or YAML based on Content-Type header.
 * Defaults to JSON if no Content-Type is specified.
 */
async function parseRequestBody(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('application/x-yaml') || contentType.includes('text/yaml')) {
    const text = await request.text()
    return parseYaml(text)
  }

  // Default to JSON
  return request.json()
}

export function createWorkflowDeployHandler() {
  return async function POST(request: NextRequest) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    try {
      let body: unknown
      try {
        body = await parseRequestBody(request)
      } catch {
        return NextResponse.json(
          { error: 'Bad Request', message: 'Invalid request body: unable to parse JSON or YAML' },
          { status: 400 },
        )
      }

      // Validate against WorkflowDefinitionSchema
      let definition
      try {
        definition = validateWorkflowDefinition(body)
      } catch (error) {
        // ZodError: check by name property (avoids direct zod import)
        if (isZodError(error)) {
          return NextResponse.json(
            {
              error: 'Bad Request',
              message: 'Invalid workflow definition',
              details: (error as { errors: unknown[] }).errors,
            },
            { status: 400 },
          )
        }
        // validateWorkflowDefinition wraps ZodError with cause when filePath is given
        if (error instanceof Error && isZodError(error.cause)) {
          return NextResponse.json(
            {
              error: 'Bad Request',
              message: 'Invalid workflow definition',
              details: (error.cause as { errors: unknown[] }).errors,
            },
            { status: 400 },
          )
        }
        throw error
      }

      // Use metadata.name as the workflow ID
      const id = definition.metadata.name

      // Persist to WorkflowStore
      const metadata = await workflowStoreSave(id, definition as unknown as Record<string, unknown>)

      log.info('Workflow deployed', {
        id: metadata.id,
        name: metadata.name,
        version: metadata.version,
      })

      return NextResponse.json(metadata, { status: 201 })
    } catch (error) {
      log.error('Failed to deploy workflow', { error })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to deploy workflow' },
        { status: 500 },
      )
    }
  }
}
