// Core types and schemas
export {
  SymbolKindSchema,
  CodeSymbolSchema,
  FileASTSchema,
  FileIndexSchema,
  SearchQuerySchema,
  SearchResultSchema,
  MemoryEntrySchema,
  DedupResultSchema,
  IndexMetadataSchema,
  RepoMapEntrySchema,
  EmbeddingChunkSchema,
  EmbeddingProviderConfigSchema,
  VectorSearchResultSchema,
  VectorIndexConfigSchema,
} from './types.js'
export type {
  SymbolKind,
  CodeSymbol,
  FileAST,
  FileIndex,
  SearchQuery,
  SearchResult,
  MemoryEntry,
  DedupResult,
  IndexMetadata,
  RepoMapEntry,
  EmbeddingChunk,
  EmbeddingProviderConfig,
  VectorSearchResult,
  VectorIndexConfig,
} from './types.js'

// Parser
export { SymbolExtractor } from './parser/symbol-extractor.js'
export type { LanguageExtractor } from './parser/symbol-extractor.js'
export { TypeScriptExtractor } from './parser/typescript-extractor.js'
export { PythonExtractor } from './parser/python-extractor.js'
export { GoExtractor } from './parser/go-extractor.js'
export { RustExtractor } from './parser/rust-extractor.js'

// Indexing
export { MerkleTree, type MerkleNode } from './indexing/merkle-tree.js'
export { GitHashProvider } from './indexing/git-hash-provider.js'
export { ChangeDetector } from './indexing/change-detector.js'
export { IncrementalIndexer } from './indexing/incremental-indexer.js'
export { VectorIndexer } from './indexing/vector-indexer.js'

// Search
export { CodeTokenizer } from './search/tokenizer.js'
export { InvertedIndex } from './search/inverted-index.js'
export { BM25 } from './search/bm25.js'
export { SearchEngine } from './search/search-engine.js'
export { HybridSearchEngine } from './search/hybrid-search.js'
export { classifyQuery } from './search/query-classifier.js'
export { minMaxNormalize } from './search/score-normalizer.js'

// Repo Map
export { DependencyGraph } from './repo-map/dependency-graph.js'
export { PageRank } from './repo-map/pagerank.js'
export { RepoMapGenerator } from './repo-map/repo-map-generator.js'

// Memory
export { xxhash64 } from './memory/xxhash.js'
export { SimHash } from './memory/simhash.js'
export { DedupPipeline } from './memory/dedup-pipeline.js'
export type { MemoryStore } from './memory/memory-store.js'
export { InMemoryStore } from './memory/memory-store.js'

// Observations (agent memory)
export {
  ObservationTypeSchema,
  FileOperationTypeSchema,
  ObservationSchema,
  InMemoryObservationSink,
  NoopObservationSink,
} from './memory/observations.js'
export type {
  ObservationType,
  FileOperationType,
  Observation,
  ObservationSink,
  FileOperationDetail,
  DecisionDetail,
  PatternDetail,
  ErrorDetail,
  SessionSummaryDetail,
} from './memory/observations.js'
export { createObservationHook, extractObservation } from './memory/observation-hook.js'
export type { ToolEvent, ObservationHookConfig } from './memory/observation-hook.js'
export { ObservationStore } from './memory/observation-store.js'
export type { ObservationRetrievalOptions, ObservationRetrievalResult } from './memory/observation-store.js'
export { createSessionSummaryHook, buildSessionSummary } from './memory/session-summary.js'
export type { SessionOutcome, SessionEndEvent, SessionSummaryHookConfig } from './memory/session-summary.js'
export { createMemoryPlugin } from './memory/memory-plugin.js'
export type { MemoryToolPlugin, MemoryToolPluginContext, MemoryPluginConfig } from './memory/memory-plugin.js'
export { buildSessionMemoryContext, DEFAULT_CONTEXT_BUDGET } from './memory/context-builder.js'
export type {
  ContextBudgetConfig,
  ContextInjectionLog,
  ContextBuilderOptions,
  ContextBuildRequest,
} from './memory/context-builder.js'

// Embedding
export type { EmbeddingProvider } from './embedding/embedding-provider.js'
export { VoyageCodeProvider } from './embedding/voyage-provider.js'
export { Chunker } from './embedding/chunker.js'

// Vector Store
export type { VectorStore } from './vector/vector-store.js'
export { InMemoryVectorStore } from './vector/hnsw-store.js'

// Reranking
export type { RerankerProvider, RerankDocument, RerankResult, RerankerConfig } from './reranking/reranker-provider.js'
export { CohereReranker } from './reranking/cohere-reranker.js'
export { VoyageReranker } from './reranking/voyage-reranker.js'

// Plugin
export { codeIntelligencePlugin } from './plugin/code-intelligence-plugin.js'
export type { FileReservationDelegate } from './plugin/file-reservation-delegate.js'

// Architectural Intelligence plugin — in-session refetch of arch context
export { createArchitecturalIntelligencePlugin } from './plugin/architectural-intelligence-plugin.js'
export type {
  ArchToolPlugin,
  ArchToolPluginContext,
  ArchitecturalIntelligencePluginConfig,
} from './plugin/architectural-intelligence-plugin.js'
