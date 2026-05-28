/**
 * Next.js Middleware — Edge Runtime Compatible
 *
 * Uses the /middleware subpath export which only loads Edge-compatible
 * modules. Do NOT import from the main barrel ('@donmai/nextjs')
 * — it pulls in Node.js-only dependencies via re-exports.
 */

import { createAgentFactoryMiddleware } from '@donmai/nextjs/middleware'

const { middleware } = createAgentFactoryMiddleware()

export { middleware }

// Must be a static object literal for Next.js build analysis
export const config = {
  matcher: [
    '/api/:path*',
    '/webhook',
    '/pipeline',
    '/settings',
    '/sessions/:path*',
    '/',
  ],
}
