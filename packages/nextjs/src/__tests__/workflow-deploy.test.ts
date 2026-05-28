import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the handler
// ---------------------------------------------------------------------------

/**
 * Minimal inline validation that mirrors WorkflowDefinitionSchema.
 * We avoid importing from @donmai/core or zod directly so the
 * test works without those packages being built.
 */
function inlineValidate(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null) {
    throw makeValidationError('Expected an object')
  }
  const obj = data as Record<string, unknown>
  if (obj.apiVersion !== 'v1.1') {
    throw makeValidationError('apiVersion must be "v1.1"')
  }
  if (obj.kind !== 'WorkflowDefinition') {
    throw makeValidationError('kind must be "WorkflowDefinition"')
  }
  const meta = obj.metadata as Record<string, unknown> | undefined
  if (!meta || typeof meta.name !== 'string' || meta.name.length === 0) {
    throw makeValidationError('metadata.name is required and must be a non-empty string')
  }
  if (!Array.isArray(obj.phases)) {
    throw makeValidationError('phases must be an array')
  }
  if (!Array.isArray(obj.transitions)) {
    throw makeValidationError('transitions must be an array')
  }
  return obj
}

/** Creates an error that duck-types as a ZodError */
function makeValidationError(message: string): Error {
  const err = new Error(message)
  err.name = 'ZodError'
  ;(err as unknown as Record<string, unknown>).errors = [{ message, path: [] }]
  return err
}

const mockWorkflowStoreSave = vi.fn()
const mockRequireWorkerAuth = vi.fn<(req: NextRequest) => NextResponse | null>(() => null)

vi.mock('@donmai/server', () => ({
  workflowStoreSave: (...args: unknown[]) => mockWorkflowStoreSave(...args),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('@donmai/core', () => ({
  validateWorkflowDefinition: (data: unknown) => inlineValidate(data),
}))

vi.mock('../middleware/worker-auth.js', () => ({
  requireWorkerAuth: (...args: unknown[]) => mockRequireWorkerAuth(...(args as [NextRequest])),
}))

// Import the handler AFTER mocks are set up
import { createWorkflowDeployHandler } from '../handlers/workflows/deploy.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function validWorkflowDefinition() {
  return {
    apiVersion: 'v1.1',
    kind: 'WorkflowDefinition',
    metadata: { name: 'test-workflow', description: 'A test workflow' },
    phases: [
      { name: 'development', template: 'dev-template' },
      { name: 'qa', template: 'qa-template' },
    ],
    transitions: [
      { from: 'Backlog', to: 'development' },
      { from: 'Finished', to: 'qa' },
    ],
  }
}

function makeRequest(body: unknown, contentType = 'application/json'): NextRequest {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
  return new NextRequest('http://localhost/api/workflows/deploy', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: bodyStr,
  })
}

function savedMetadata() {
  return {
    id: 'test-workflow',
    name: 'test-workflow',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/workflows/deploy', () => {
  let handler: ReturnType<typeof createWorkflowDeployHandler>

  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireWorkerAuth.mockReturnValue(null) // authorized by default
    mockWorkflowStoreSave.mockResolvedValue(savedMetadata())
    handler = createWorkflowDeployHandler()
  })

  // ---- Auth ---------------------------------------------------------------

  it('returns 401 when no auth', async () => {
    const unauthorizedResponse = NextResponse.json(
      { error: 'Unauthorized', message: 'Invalid or missing API key' },
      { status: 401 },
    )
    mockRequireWorkerAuth.mockReturnValue(unauthorizedResponse)

    const request = makeRequest(validWorkflowDefinition())
    const response = await handler(request)

    expect(response.status).toBe(401)
    const json = await response.json() as Json
    expect(json.error).toBe('Unauthorized')
  })

  // ---- Body parsing errors ------------------------------------------------

  it('returns 400 for invalid JSON body', async () => {
    const request = new NextRequest('http://localhost/api/workflows/deploy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not valid json',
    })

    const response = await handler(request)

    expect(response.status).toBe(400)
    const json = await response.json() as Json
    expect(json.error).toBe('Bad Request')
    expect(json.message).toMatch(/unable to parse/)
  })

  // ---- Zod validation errors ----------------------------------------------

  it('returns 400 for invalid workflow definition (Zod validation error)', async () => {
    const invalidDef = {
      apiVersion: 'v1.1',
      kind: 'WorkflowDefinition',
      metadata: { name: '' }, // name must be non-empty
      phases: [],
      transitions: [],
    }

    const request = makeRequest(invalidDef)
    const response = await handler(request)

    expect(response.status).toBe(400)
    const json = await response.json() as Json
    expect(json.error).toBe('Bad Request')
    expect(json.message).toBe('Invalid workflow definition')
    expect(json.details).toBeDefined()
    expect(Array.isArray(json.details)).toBe(true)
  })

  it('returns 400 when kind is missing', async () => {
    const request = makeRequest({
      apiVersion: 'v1.1',
      metadata: { name: 'test' },
      phases: [],
      transitions: [],
    })

    const response = await handler(request)

    expect(response.status).toBe(400)
    const json = await response.json() as Json
    expect(json.error).toBe('Bad Request')
  })

  // ---- Successful JSON deploy ---------------------------------------------

  it('returns 201 with metadata on valid JSON deploy', async () => {
    const request = makeRequest(validWorkflowDefinition())
    const response = await handler(request)

    expect(response.status).toBe(201)
    const json = await response.json() as Json
    expect(json.id).toBe('test-workflow')
    expect(json.name).toBe('test-workflow')
    expect(json.version).toBe(1)
    expect(json.createdAt).toBeDefined()
    expect(json.updatedAt).toBeDefined()

    // Verify workflowStoreSave was called with correct args
    expect(mockWorkflowStoreSave).toHaveBeenCalledTimes(1)
    expect(mockWorkflowStoreSave).toHaveBeenCalledWith(
      'test-workflow',
      expect.objectContaining({
        apiVersion: 'v1.1',
        kind: 'WorkflowDefinition',
        metadata: { name: 'test-workflow', description: 'A test workflow' },
      }),
    )
  })

  // ---- Successful YAML deploy ---------------------------------------------

  it('returns 201 on valid YAML deploy', async () => {
    const yamlBody = `
apiVersion: "v1.1"
kind: WorkflowDefinition
metadata:
  name: yaml-workflow
  description: Deployed via YAML
phases:
  - name: development
    template: dev-template
transitions:
  - from: Backlog
    to: development
`
    mockWorkflowStoreSave.mockResolvedValue({
      id: 'yaml-workflow',
      name: 'yaml-workflow',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const request = makeRequest(yamlBody, 'application/x-yaml')
    const response = await handler(request)

    expect(response.status).toBe(201)
    const json = await response.json() as Json
    expect(json.id).toBe('yaml-workflow')
    expect(json.name).toBe('yaml-workflow')

    expect(mockWorkflowStoreSave).toHaveBeenCalledWith(
      'yaml-workflow',
      expect.objectContaining({
        apiVersion: 'v1.1',
        kind: 'WorkflowDefinition',
        metadata: { name: 'yaml-workflow', description: 'Deployed via YAML' },
      }),
    )
  })

  it('returns 201 on valid YAML deploy with text/yaml content type', async () => {
    const yamlBody = `
apiVersion: "v1.1"
kind: WorkflowDefinition
metadata:
  name: yaml-workflow-2
phases:
  - name: build
    template: build-template
transitions:
  - from: Ready
    to: build
`
    mockWorkflowStoreSave.mockResolvedValue({
      id: 'yaml-workflow-2',
      name: 'yaml-workflow-2',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const request = makeRequest(yamlBody, 'text/yaml')
    const response = await handler(request)

    expect(response.status).toBe(201)
    const json = await response.json() as Json
    expect(json.id).toBe('yaml-workflow-2')
  })

  // ---- Store failure ------------------------------------------------------

  it('returns 500 on store failure', async () => {
    mockWorkflowStoreSave.mockRejectedValue(new Error('Redis connection failed'))

    const request = makeRequest(validWorkflowDefinition())
    const response = await handler(request)

    expect(response.status).toBe(500)
    const json = await response.json() as Json
    expect(json.error).toBe('Internal Server Error')
    expect(json.message).toBe('Failed to deploy workflow')
  })
})
