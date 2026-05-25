/**
 * POST /api/a2a
 *
 * A2A JSON-RPC 2.0 endpoint. Parses incoming requests, delegates to
 * `createA2aRequestHandler()` from @donmai/server,
 * and returns JSON-RPC responses.
 *
 * Supports both regular JSON responses and SSE streaming via
 * Accept header negotiation per the A2A spec.
 *
 * Auth uses the existing timing-safe Bearer token validation.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  createA2aRequestHandler,
  extractBearerToken,
  verifyApiKey,
  createLogger,
} from '@donmai/server'
import type {
  A2aHandlerOptions,
  A2aRequestHandler,
} from '@donmai/server'
import type { JsonRpcRequest } from '@donmai/server'

const log = createLogger('api:a2a:rpc')

/**
 * Configuration for the A2A JSON-RPC route handler.
 */
export interface A2aRpcRouteConfig {
  /** Callbacks for task lifecycle operations */
  callbacks: Pick<A2aHandlerOptions, 'onSendMessage' | 'onGetTask' | 'onCancelTask'>

  /**
   * Optional custom auth verifier. Defaults to Bearer token validation
   * using the WORKER_API_KEY environment variable with timing-safe comparison.
   */
  verifyAuth?: (authHeader: string | undefined) => boolean

  /**
   * Optional callback for SSE streaming. When provided and the client
   * sends `Accept: text/event-stream`, the handler delegates to this
   * function for streaming responses. Wired in REN-1149.
   */
  onStreamRequest?: (
    request: NextRequest,
    rpcRequest: JsonRpcRequest,
    authHeader: string | undefined,
  ) => Promise<Response>
}

/**
 * Default auth verifier using timing-safe Bearer token comparison
 * against the WORKER_API_KEY environment variable.
 */
function defaultVerifyAuth(authHeader: string | undefined): boolean {
  const token = extractBearerToken(authHeader ?? null)
  if (!token) return false
  return verifyApiKey(token)
}

/**
 * Create a POST handler for `/api/a2a`.
 *
 * @param config - A2A RPC configuration with callbacks
 * @returns Next.js route handler
 */
export function createA2aRpcHandler(config: A2aRpcRouteConfig) {
  const verifyAuth = config.verifyAuth ?? defaultVerifyAuth

  const handler: A2aRequestHandler = createA2aRequestHandler({
    ...config.callbacks,
    verifyAuth,
  })

  return async function POST(request: NextRequest) {
    try {
      // Parse the JSON-RPC request body
      let rpcRequest: JsonRpcRequest
      try {
        rpcRequest = (await request.json()) as JsonRpcRequest
      } catch {
        return NextResponse.json(
          {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          },
          { status: 400 }
        )
      }

      // Validate JSON-RPC 2.0 envelope
      if (rpcRequest.jsonrpc !== '2.0' || !rpcRequest.method) {
        return NextResponse.json(
          {
            jsonrpc: '2.0',
            id: rpcRequest.id ?? null,
            error: { code: -32600, message: 'Invalid Request' },
          },
          { status: 400 }
        )
      }

      const authHeader = request.headers.get('authorization') ?? undefined

      // SSE streaming: if client requests event-stream and we have a stream handler
      const acceptHeader = request.headers.get('accept') ?? ''
      if (
        acceptHeader.includes('text/event-stream') &&
        config.onStreamRequest
      ) {
        // Auth check before streaming
        if (!verifyAuth(authHeader)) {
          return NextResponse.json(
            {
              jsonrpc: '2.0',
              id: rpcRequest.id ?? null,
              error: { code: -32000, message: 'Unauthorized' },
            },
            { status: 401 }
          )
        }
        return (await config.onStreamRequest(request, rpcRequest, authHeader)) as unknown as NextResponse
      }

      // Standard JSON-RPC handling
      const response = await handler(rpcRequest, authHeader)

      // Map JSON-RPC error codes to HTTP status codes
      const httpStatus = response.error
        ? response.error.code === -32000
          ? 401  // Unauthorized
          : response.error.code === -32700
            ? 400  // Parse error
            : response.error.code === -32600
              ? 400  // Invalid Request
              : response.error.code === -32601
                ? 404  // Method not found
                : response.error.code === -32602
                  ? 400  // Invalid params
                  : 500  // Internal error
        : 200

      return NextResponse.json(response, { status: httpStatus })
    } catch (error) {
      log.error('Failed to handle A2A request', { error })
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'Internal error' },
        },
        { status: 500 }
      )
    }
  }
}
