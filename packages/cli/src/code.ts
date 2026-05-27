#!/usr/bin/env node
/**
 * AgentFactory Code Intelligence CLI
 *
 * Exposes code-intelligence tools as CLI commands for use by Task sub-agents
 * and other non-MCP contexts.
 *
 * Usage:
 *   af-code <command> [options]
 *
 * Commands:
 *   search-symbols <query>   Search for code symbols by name
 *   get-repo-map             Get PageRank-ranked repository file map
 *   search-code <query>      BM25/hybrid code search
 *   check-duplicate          Check content for duplicates
 *   find-type-usages <name>  Find all switch/case, mapping, and usage sites for a type
 *   validate-cross-deps      Check cross-package imports have package.json entries
 *   help                     Show this help message
 *
 * Environment:
 *   VOYAGE_AI_API_KEY        Optional — enables semantic vector embeddings
 *   COHERE_API_KEY           Optional — enables cross-encoder reranking
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local
config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true })

import { runCodeIntelligence, parseCodeArgs } from './lib/code-intelligence-runner.js'

function printHelp(): void {
  console.log(`
AgentFactory Code Intelligence CLI — codebase search and analysis

Usage:
  af-code <command> [options]

Commands:
  search-symbols <query>      Search for functions, classes, types by name
  get-repo-map                Get PageRank-ranked repository file map
  search-code <query>         BM25/hybrid keyword search with code-aware tokenization
  check-duplicate             Check content for exact/near duplicates
  help                        Show this help message

Options (search-symbols):
  --max-results <N>           Maximum results (default: 20)
  --kinds <kinds>             Comma-separated symbol kinds: function,class,interface,type,etc.
  --file-pattern <pattern>    Filter by file pattern (e.g. "*.ts", "src/**")

Options (get-repo-map):
  --max-files <N>             Maximum files to include (default: 50)
  --file-patterns <patterns>  Comma-separated file pattern filters

Options (search-code):
  --max-results <N>           Maximum results (default: 20)
  --language <lang>           Filter by language (e.g. typescript, python)

Options (check-duplicate):
  --content <string>          Content to check (inline)
  --content-file <path>       Path to file containing content to check

Options (find-type-usages):
  --max-results <N>           Maximum results (default: 50)

Options (validate-cross-deps):
  [path]                      Optional directory/file to scope the check

Index:
  First invocation builds the index from source files (~5-10s).
  Subsequent calls reuse the persisted index from .donmai/code-index/.

Examples:
  af-code search-symbols "SearchEngine"
  af-code search-symbols "handleRequest" --kinds "function,method" --file-pattern "*.ts"
  af-code get-repo-map --max-files 20
  af-code search-code "incremental indexer" --language typescript
  af-code check-duplicate --content "function hello() { return 'world' }"
  af-code check-duplicate --content-file /tmp/snippet.ts
  af-code find-type-usages "AgentWorkType"
  af-code validate-cross-deps
  af-code validate-cross-deps packages/linear
`)
}

async function main(): Promise<void> {
  const { command, args, positionalArgs } = parseCodeArgs(process.argv.slice(2))

  if (!command || command === 'help' || args['help'] || args['h']) {
    printHelp()
    return
  }

  const result = await runCodeIntelligence({
    command,
    args,
    positionalArgs,
    cwd: process.cwd(),
  })

  console.log(JSON.stringify(result.output, null, 2))
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
