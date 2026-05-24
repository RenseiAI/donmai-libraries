import { extractBearerToken, verifyApiKey, isWorkerAuthConfigured } from '@donmai/server'

const MCP_API_KEY_ENV = 'MCP_API_KEY'

export function isMcpAuthConfigured(): boolean {
  return isWorkerAuthConfigured(MCP_API_KEY_ENV) || isWorkerAuthConfigured('WORKER_API_KEY')
}

export function verifyMcpAuth(authHeader: string | null | undefined): { authorized: boolean; error?: string } {
  if (!isMcpAuthConfigured()) {
    // No auth configured — allow all requests (dev mode)
    return { authorized: true }
  }

  const token = extractBearerToken(authHeader)
  if (!token) {
    return { authorized: false, error: 'Missing or invalid Authorization header. Expected: Bearer <api-key>' }
  }

  // Try MCP-specific key first, then fall back to worker key
  const mcpKey = process.env[MCP_API_KEY_ENV]
  const workerKey = process.env.WORKER_API_KEY

  if (mcpKey && verifyApiKey(token, mcpKey)) {
    return { authorized: true }
  }
  if (workerKey && verifyApiKey(token, workerKey)) {
    return { authorized: true }
  }

  return { authorized: false, error: 'Invalid API key' }
}
