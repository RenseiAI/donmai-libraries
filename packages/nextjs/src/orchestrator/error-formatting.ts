/**
 * Generic error formatting for Linear comments.
 */

import { AgentSpawnError } from '@donmai/plugin-linear'

/**
 * Format an error for posting as a Linear comment with markdown.
 */
export function formatErrorForComment(error: Error): string {
  const lines = ['## Agent Error', '', `**${error.name}**: ${error.message}`]

  if (error instanceof AgentSpawnError) {
    lines.push('')
    lines.push(`- Issue ID: ${error.issueId}`)
    if (error.sessionId) {
      lines.push(`- Session ID: ${error.sessionId}`)
    }
    lines.push(`- Retryable: ${error.isRetryable ? 'Yes' : 'No'}`)
    if (error.cause) {
      lines.push(`- Cause: ${(error.cause as Error).message}`)
    }
  }

  if (error.stack) {
    lines.push('')
    lines.push('<details>')
    lines.push('<summary>Stack Trace</summary>')
    lines.push('')
    lines.push('```')
    lines.push(error.stack)
    lines.push('```')
    lines.push('</details>')
  }

  lines.push('')
  lines.push(`---`)
  lines.push(`*Error occurred at ${new Date().toISOString()}*`)

  return lines.join('\n')
}
