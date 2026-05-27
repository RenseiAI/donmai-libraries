# Code Intelligence

The `@renseiai/agentfactory-code-intelligence` package provides 6 core tools for codebase navigation, search, and analysis, plus 3 optional file reservation tools for parallel agent safety. These tools help agents understand large codebases quickly and make informed implementation decisions.

## Tools

### `af_code_search_code` — Full-Text Code Search

Search source files using BM25 ranking with optional semantic similarity reranking.

```
Search for: "createOrchestrator"
→ Returns ranked list of files and line numbers matching the query
```

**When to use:** Finding specific code patterns, function calls, configuration values, or error messages.

### `af_code_search_symbols` — Symbol Search

Find functions, classes, interfaces, types, and variables by name across the codebase.

```
Search for symbol: "AgentProvider"
→ Returns: interface AgentProvider in packages/core/src/providers/types.ts:15
```

Uses Tree-sitter AST parsing for accurate symbol extraction (not regex-based).

**When to use:** Finding type definitions, function signatures, class hierarchies, or exported symbols.

### `af_code_get_repo_map` — Repository Overview

Generate a PageRank-based overview of the repository showing the most important files and their key symbols.

```
→ Returns ranked list of files with their exported symbols,
  ordered by import graph centrality (PageRank)
```

The repo map analyzes the import graph to determine which files are most central to the codebase. Files imported by many other files rank higher.

**When to use:** Understanding a new codebase, finding the most important modules, or deciding where to start reading.

### `af_code_find_type_usages` — Type Usage Finder

Find all usages of a type across the codebase, including switch statements, mapping objects, imports, type references, and exhaustive checks.

```
Find usages of: "AgentWorkType"
→ Returns:
  - switch cases in orchestrator.ts:150
  - mapping object in work-types.ts:40
  - import in providers/index.ts:3
  - type reference in templates/types.ts:17
  - exhaustive check in governor.ts:200
```

Usage kinds: `switch_case`, `mapping_object`, `import`, `type_reference`, `exhaustive_check`.

**When to use:** Adding a new variant to a union type, understanding where a type is consumed, or checking exhaustiveness.

### `af_code_validate_cross_deps` — Cross-Package Dependency Validation

Validate that imports between packages respect the dependency graph defined in `package.json`.

```
→ Checks all import statements against declared dependencies
→ Reports violations: "packages/cli imports from packages/core but doesn't declare it"
```

**When to use:** After refactoring imports, adding new cross-package dependencies, or during CI validation.

### `af_code_check_duplicate` — Duplicate Detection

Detect duplicate or near-duplicate code across the codebase using two strategies:

- **xxHash64 exact match** — finds byte-identical duplicates
- **SimHash near-duplicate** — finds structurally similar code with minor differences

```
Check for duplicates of: function in utils.ts:50-80
→ Returns: near-duplicate found in helpers.ts:120-150 (similarity: 0.92)
```

**When to use:** Before writing new utility functions, during code review, or to identify consolidation opportunities.

## File Reservation Tools (Optional)

When agents run in parallel (e.g., coordination workflows), file reservation tools prevent merge conflicts by letting agents claim files before modifying them. These 3 tools are only available when the orchestrator provides a `FileReservationDelegate`.

### `af_code_reserve_files` — Reserve Files

Claim exclusive access to files before modification. Other agents will see these files as reserved.

```
Reserve: ["src/utils.ts", "src/helpers.ts"]
→ Returns: reservation confirmed (or conflict if already reserved)
```

**When to use:** Before modifying shared files in a parallel coordination workflow.

### `af_code_check_conflicts` — Check File Conflicts

Check whether files you plan to modify are reserved by another agent.

```
Check: ["src/utils.ts"]
→ Returns: { conflicting: [], available: ["src/utils.ts"] }
```

**When to use:** Before starting work, to see if another agent is already modifying a file.

### `af_code_release_files` — Release File Reservations

Release previously reserved files so other agents can modify them.

```
Release: ["src/utils.ts"]
→ Returns: reservation released
```

**When to use:** After committing changes, to unblock other agents waiting on those files.

## Supported Languages

| Language | Extensions | Symbol Extraction | Search |
|----------|-----------|------------------|--------|
| TypeScript | `.ts`, `.tsx` | Full AST | Full |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | Full AST | Full |
| Python | `.py` | Full AST | Full |
| Go | `.go` | Full AST | Full |
| Rust | `.rs` | Full AST | Full |

## Search Architecture

### Hybrid BM25 + Semantic Search

The search engine combines two ranking strategies:

1. **BM25 (Best Matching 25)** — term-frequency based ranking that excels at exact keyword matches. Fast, no external dependencies.

2. **Semantic embeddings** — vector similarity search that understands meaning. Catches conceptual matches that keyword search misses (e.g., searching "error handling" finds `try/catch` blocks).

Results from both strategies are merged and optionally reranked using a dedicated reranking model.

### Reranking Providers

When configured, search results are reranked using a dedicated model for improved relevance:

| Provider | Model | Description |
|----------|-------|-------------|
| Cohere | `rerank-english-v3.0` | High-quality reranking via Cohere API |
| Voyage | `voyage-rerank-2` | Reranking via Voyage AI API |

Set the appropriate environment variables to enable:

```bash
VOYAGE_AI_API_KEY=your-key     # Enable semantic vector embeddings (hybrid BM25 + vector mode)
COHERE_API_KEY=your-key        # Enable Cohere cross-encoder reranking
```

Without these keys, agents still get full BM25 keyword search, symbol search, repo maps, and duplicate detection.

### PageRank Repo Map

The repo map generator:

1. Parses all source files with Tree-sitter to extract symbols and imports
2. Builds a directed graph where edges represent import relationships
3. Runs PageRank to score each file by structural importance
4. Returns the top-N files with their key exported symbols

This gives agents a quick understanding of the codebase's most central modules.

## Usage Modes

### In-Process MCP Tools (Claude Provider)

When using the Claude provider with `useToolPlugins: true`, the code intelligence tools run in-process as MCP tools. Agents call them directly:

```
af_code_search_code({ query: "createOrchestrator", maxResults: 10 })
af_code_search_symbols({ query: "AgentProvider", kind: "interface" })
af_code_get_repo_map({ maxFiles: 20 })
```

### CLI (`af-code`)

For non-Claude providers or standalone usage:

```bash
# BM25 keyword search
pnpm af-code search-code "createOrchestrator" --max-results 10

# Search symbols
pnpm af-code search-symbols "AgentProvider" --kinds interface --file-pattern "*.ts"

# Generate repo map
pnpm af-code get-repo-map --max-files 20

# Find type usages
pnpm af-code find-type-usages "AgentWorkType" --max-results 50

# Validate cross-deps
pnpm af-code validate-cross-deps

# Check duplicates
pnpm af-code check-duplicate --content "function myHelper() { ... }"
pnpm af-code check-duplicate --content-file /tmp/snippet.ts
```

## Configuration

### Ignored Directories

The following directories are automatically excluded from indexing:

`node_modules`, `dist`, `.git`, `.next`, `.turbo`, `build`, `coverage`, `__pycache__`, `.agentfactory`, `.worktrees`, `vendor`, `target`

### File Size Limit

Files larger than 512 KB are skipped during indexing.

### Incremental Indexing

The `IncrementalIndexer` persists its index to `.donmai/code-index/` (add to `.gitignore`). First invocation builds the full index (~5-10s); subsequent runs re-index only changed files via Merkle tree diffing. This makes searches fast even in large codebases.
