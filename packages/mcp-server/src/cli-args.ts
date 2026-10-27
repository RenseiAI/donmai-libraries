export interface CliArgs {
  transport: 'stdio' | 'http'
  port: number | undefined
  host: string | undefined
  /** true only when --allow-unauthenticated-remote is passed; otherwise undefined so the env default applies. */
  allowUnauthenticatedRemote: true | undefined
}

export function parseCliArgs(args: string[]): CliArgs {
  const portIdx = args.indexOf('--port')
  const hostIdx = args.indexOf('--host')
  return {
    transport: args.includes('--stdio') ? 'stdio' : 'http',
    port: portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : undefined,
    host: hostIdx !== -1 ? args[hostIdx + 1] : undefined,
    allowUnauthenticatedRemote: args.includes('--allow-unauthenticated-remote') ? true : undefined,
  }
}
