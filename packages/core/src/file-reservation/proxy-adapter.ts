/**
 * HTTP Proxy Adapter for File Reservation
 *
 * Creates a FileReservationDelegate that calls the platform API instead of
 * Redis directly. Used when workers authenticate via platform credentials
 * (apiActivityConfig) and don't have direct REDIS_URL access.
 *
 * Follows the same pattern as ProxyIssueTrackerAdapter for Linear API proxying.
 */

export interface ProxyFileReservationConfig {
  /** Platform API base URL (e.g., https://donmai.dev/dashboard) */
  apiUrl: string
  /** Worker API key (Bearer token) */
  apiKey: string
}

export interface ProxyFileReservationDelegate {
  reserveFiles(
    sessionId: string,
    filePaths: string[],
    reason?: string,
  ): Promise<{
    reserved: string[]
    conflicts: Array<{
      filePath: string
      heldBy: { sessionId: string; reservedAt: number }
    }>
  }>
  checkFileConflicts(
    sessionId: string,
    filePaths: string[],
  ): Promise<
    Array<{
      filePath: string
      heldBy: { sessionId: string; reservedAt: number }
    }>
  >
  releaseFiles(sessionId: string, filePaths: string[]): Promise<number>
  releaseAllSessionFiles(sessionId: string): Promise<number>
}

/**
 * Create a file reservation delegate that proxies through the platform API.
 * The platform handles org-scoped Redis keys and tenant isolation.
 */
export function createProxyFileReservationDelegate(
  config: ProxyFileReservationConfig,
): ProxyFileReservationDelegate {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  }

  return {
    async reserveFiles(sessionId, filePaths, reason?) {
      try {
        const res = await fetch(
          `${config.apiUrl}/api/sessions/${sessionId}/files/reserve`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ filePaths, reason }),
          },
        )
        if (!res.ok) {
          console.error(`[file-reservation-proxy] reserve failed: ${res.status} ${res.statusText}`)
          return { reserved: [], conflicts: [] }
        }
        return await res.json() as { reserved: string[]; conflicts: Array<{ filePath: string; heldBy: { sessionId: string; reservedAt: number } }> }
      } catch (err) {
        console.error('[file-reservation-proxy] reserve error:', err)
        return { reserved: [], conflicts: [] }
      }
    },

    async checkFileConflicts(sessionId, filePaths) {
      try {
        const res = await fetch(
          `${config.apiUrl}/api/sessions/${sessionId}/files/check-conflicts`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ filePaths }),
          },
        )
        if (!res.ok) {
          console.error(`[file-reservation-proxy] check-conflicts failed: ${res.status} ${res.statusText}`)
          return []
        }
        const data = await res.json() as { conflicts?: Array<{ filePath: string; heldBy: { sessionId: string; reservedAt: number } }> }
        return data.conflicts ?? []
      } catch (err) {
        console.error('[file-reservation-proxy] check-conflicts error:', err)
        return []
      }
    },

    async releaseFiles(sessionId, filePaths) {
      try {
        const res = await fetch(
          `${config.apiUrl}/api/sessions/${sessionId}/files/release`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ filePaths }),
          },
        )
        if (!res.ok) {
          console.error(`[file-reservation-proxy] release failed: ${res.status} ${res.statusText}`)
          return 0
        }
        const data = await res.json() as { released?: number }
        return data.released ?? 0
      } catch (err) {
        console.error('[file-reservation-proxy] release error:', err)
        return 0
      }
    },

    async releaseAllSessionFiles(sessionId) {
      try {
        const res = await fetch(
          `${config.apiUrl}/api/sessions/${sessionId}/files/release-all`,
          {
            method: 'POST',
            headers,
          },
        )
        if (!res.ok) {
          console.error(`[file-reservation-proxy] release-all failed: ${res.status} ${res.statusText}`)
          return 0
        }
        const data = await res.json() as { released?: number }
        return data.released ?? 0
      } catch (err) {
        console.error('[file-reservation-proxy] release-all error:', err)
        return 0
      }
    },
  }
}
