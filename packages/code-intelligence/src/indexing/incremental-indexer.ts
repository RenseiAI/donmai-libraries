import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { FileIndex, IndexMetadata, CodeSymbol, FileAST } from '../types.js'
import { MerkleTree } from './merkle-tree.js'
import { ChangeDetector, type ChangeSet } from './change-detector.js'
import { GitHashProvider } from './git-hash-provider.js'
import { SymbolExtractor } from '../parser/symbol-extractor.js'
import type { VectorIndexer } from './vector-indexer.js'

export interface IndexerOptions {
  indexDir?: string
  filePatterns?: string[]
}

/**
 * Orchestrates incremental re-indexing of only changed files.
 * Persists index to `.donmai/code-index/`.
 */
export class IncrementalIndexer {
  private hashProvider = new GitHashProvider()
  private changeDetector = new ChangeDetector()
  private extractor: SymbolExtractor
  private indexDir: string
  private previousTree: MerkleTree | undefined
  private fileIndex: Map<string, FileIndex> = new Map()
  private vectorIndexer: VectorIndexer | undefined

  constructor(extractor: SymbolExtractor, options: IndexerOptions = {}) {
    this.extractor = extractor
    this.indexDir = options.indexDir ?? '.donmai/code-index'
  }

  /** Set an optional VectorIndexer for dense vector indexing. */
  setVectorIndexer(indexer: VectorIndexer): void {
    this.vectorIndexer = indexer
  }

  /**
   * Index files, returning only the changed ones.
   * @param files Map of filePath -> content
   */
  async index(files: Map<string, string>): Promise<{
    changes: ChangeSet
    indexed: FileIndex[]
    metadata: IndexMetadata
  }> {
    const newTree = MerkleTree.fromFiles(files)

    let changes: ChangeSet
    if (this.previousTree) {
      changes = this.changeDetector.detect(this.previousTree, newTree)
    } else {
      changes = {
        added: [...files.keys()].sort(),
        modified: [],
        deleted: [],
      }
    }

    // Remove deleted files from index
    for (const path of changes.deleted) {
      this.fileIndex.delete(path)
    }

    // Index added and modified files
    const indexed: FileIndex[] = []
    const addedAsts: FileAST[] = []
    const addedContents: Map<string, string> = new Map()
    const modifiedAsts: FileAST[] = []
    const modifiedContents: Map<string, string> = new Map()

    const toIndex = [...changes.added, ...changes.modified]
    for (const path of toIndex) {
      const content = files.get(path)
      if (!content) continue

      const ast = this.extractor.extractFromSource(content, path)
      const gitHash = this.hashProvider.hashContent(content)

      const fileIdx: FileIndex = {
        filePath: path,
        gitHash,
        symbols: ast.symbols,
        lastIndexed: Date.now(),
      }
      this.fileIndex.set(path, fileIdx)
      indexed.push(fileIdx)

      // Collect ASTs/contents for vector indexing
      if (changes.added.includes(path)) {
        addedAsts.push(ast)
        addedContents.set(path, content)
      } else {
        modifiedAsts.push(ast)
        modifiedContents.set(path, content)
      }
    }

    // Vector indexing (optional)
    if (this.vectorIndexer) {
      if (changes.deleted.length > 0) {
        await this.vectorIndexer.removeFiles(changes.deleted)
      }
      if (addedAsts.length > 0) {
        await this.vectorIndexer.indexFiles(addedAsts, addedContents)
      }
      if (modifiedAsts.length > 0) {
        await this.vectorIndexer.updateFiles(modifiedAsts, modifiedContents)
      }
    }

    this.previousTree = newTree

    // Collect all symbols for metadata
    const allSymbols: CodeSymbol[] = []
    const languages = new Set<string>()
    for (const fi of this.fileIndex.values()) {
      allSymbols.push(...fi.symbols)
      for (const s of fi.symbols) {
        if (s.language) languages.add(s.language)
      }
    }

    const metadata: IndexMetadata = {
      version: 1,
      rootHash: newTree.getRootHash(),
      totalFiles: this.fileIndex.size,
      totalSymbols: allSymbols.length,
      lastUpdated: Date.now(),
      languages: [...languages].sort(),
    }

    return { changes, indexed, metadata }
  }

  /** Save index to disk. */
  async save(basePath: string): Promise<void> {
    const dir = join(basePath, this.indexDir)
    await mkdir(dir, { recursive: true })

    const data = {
      files: Object.fromEntries(this.fileIndex),
      rootHash: this.previousTree?.getRootHash() ?? '',
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify(data, null, 2))

    // Save vector store if available
    if (this.vectorIndexer) {
      const vectorDir = join(dir, 'vectors')
      await this.vectorIndexer.getStore().save(vectorDir)
    }
  }

  /** Load index from disk. */
  async load(basePath: string): Promise<boolean> {
    const indexPath = join(basePath, this.indexDir, 'index.json')
    try {
      const raw = await readFile(indexPath, 'utf-8')
      const data = JSON.parse(raw)
      this.fileIndex = new Map(Object.entries(data.files))

      // Rebuild Merkle tree from stored hashes
      const fileHashes = new Map<string, string>()
      for (const [path, fi] of this.fileIndex) {
        fileHashes.set(path, (fi as FileIndex).gitHash)
      }
      this.previousTree = MerkleTree.fromHashes(fileHashes)

      // Load vector store if available
      if (this.vectorIndexer) {
        const vectorDir = join(basePath, this.indexDir, 'vectors')
        try {
          await this.vectorIndexer.getStore().load(vectorDir)
        } catch {
          // Vector store may not exist yet — that's fine
        }
      }

      return true
    } catch {
      return false
    }
  }

  /** Get all indexed symbols. */
  getAllSymbols(): CodeSymbol[] {
    const symbols: CodeSymbol[] = []
    for (const fi of this.fileIndex.values()) {
      symbols.push(...fi.symbols)
    }
    return symbols
  }

  /** Get the current file index. */
  getFileIndex(): Map<string, FileIndex> {
    return new Map(this.fileIndex)
  }
}
