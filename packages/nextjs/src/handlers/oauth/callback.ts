/**
 * OAuth Callback Handler for Linear
 *
 * Exchanges an authorization code for an access token and stores it
 * in Redis for workspace-specific token resolution.
 *
 * @see https://developers.linear.app/docs/oauth/authentication
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  storeToken,
  fetchOrganization,
  isRedisConfigured,
  createLogger,
  generateRequestId,
  type LinearTokenResponse,
} from '@donmai/server'
import type { RouteHandler } from '../../types.js'

/**
 * Configuration for the OAuth callback handler.
 */
export interface OAuthConfig {
  /** Linear OAuth client ID (defaults to LINEAR_CLIENT_ID env) */
  clientId?: string
  /** Linear OAuth client secret (defaults to LINEAR_CLIENT_SECRET env) */
  clientSecret?: string
  /** Application URL for redirect URI (defaults to NEXT_PUBLIC_APP_URL env) */
  appUrl?: string
  /** Redirect path on success (defaults to '/?oauth=success') */
  successRedirect?: string
}

const baseLogger = createLogger('oauth-callback')

/**
 * Create an OAuth callback route handler for Linear.
 *
 * @example
 * ```typescript
 * // In app/callback/route.ts:
 * import { createOAuthCallbackHandler } from '@donmai/nextjs'
 * export const { GET } = createOAuthCallbackHandler()
 * ```
 */
export function createOAuthCallbackHandler(config?: OAuthConfig): { GET: RouteHandler } {
  return {
    GET: async (request: NextRequest) => {
      const requestId = generateRequestId()
      const log = baseLogger.child({ requestId })

      const clientId = config?.clientId ?? process.env.LINEAR_CLIENT_ID
      const clientSecret = config?.clientSecret ?? process.env.LINEAR_CLIENT_SECRET
      const appUrl = config?.appUrl
        ?? process.env.NEXT_PUBLIC_APP_URL
        ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
        ?? (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`)
        ?? 'http://localhost:3002'
      const successRedirect = config?.successRedirect ?? '/?oauth=success'

      const code = request.nextUrl.searchParams.get('code')
      const error = request.nextUrl.searchParams.get('error')
      const errorDescription = request.nextUrl.searchParams.get('error_description')

      if (error) {
        log.error('OAuth error from Linear', { oauthError: error, errorDescription })
        return NextResponse.json(
          { error, description: errorDescription, requestId },
          { status: 400 }
        )
      }

      if (!code) {
        log.warn('Missing authorization code')
        return NextResponse.json(
          { error: 'Missing authorization code', requestId },
          { status: 400 }
        )
      }

      if (!clientId || !clientSecret) {
        log.error('OAuth credentials not configured')
        return NextResponse.json(
          { error: 'OAuth not configured', requestId },
          { status: 500 }
        )
      }

      try {
        log.debug('Exchanging authorization code for token')

        const tokenResponse = await fetch('https://api.linear.app/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: `${appUrl}/callback`,
            code,
          }),
        })

        if (!tokenResponse.ok) {
          const errorText = await tokenResponse.text()
          log.error('Token exchange failed', {
            statusCode: tokenResponse.status,
            errorDetails: errorText,
          })
          return NextResponse.json(
            { error: 'Token exchange failed', details: errorText, requestId },
            { status: 400 }
          )
        }

        const tokenData = (await tokenResponse.json()) as LinearTokenResponse

        if (isRedisConfigured()) {
          const organization = await fetchOrganization(tokenData.access_token)

          if (organization) {
            await storeToken(organization.id, tokenData, organization.name)
            log.info('OAuth successful, token stored', {
              workspaceId: organization.id,
              workspaceName: organization.name,
            })
          } else {
            log.warn('OAuth successful but could not fetch organization info - token not stored')
          }
        } else {
          log.info('OAuth successful, token received (Redis not configured for storage)')
        }

        return NextResponse.redirect(new URL(successRedirect, appUrl))
      } catch (err) {
        log.error('OAuth callback error', { error: err })
        return NextResponse.json(
          { error: 'Internal server error', requestId },
          { status: 500 }
        )
      }
    },
  }
}
