/**
 * Scheduler Defaults
 *
 * Pre-instantiated default scorer set for convenience. The default filter
 * set is already exported as `DEFAULT_FILTERS` from `./filters.js`.
 *
 * Usage:
 *   import { DEFAULT_FILTERS, DEFAULT_SCORERS } from '@donmai/server'
 */

import { createDefaultScorers } from './scorers.js'

/**
 * Pre-instantiated default scorers (all 5, weights summing to 1.0).
 * Equivalent to calling `createDefaultScorers()`.
 */
export const DEFAULT_SCORERS = createDefaultScorers()
