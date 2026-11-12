import { detectFileEncoding } from './file.js'
import { getFsImplementation } from './fsOperations.js'

type CachedFileData = {
  content: string
  encoding: BufferEncoding
  mtime: number
  ctime: number
  size: number
  dev: number
  ino: number
  retainedBytes: number
}

const MAX_RETAINED_BYTES = 16 * 1024 * 1024
// Budget strings as UTF-16 even when the engine can store them as Latin-1.
// Include a fixed bookkeeping charge; this is a cache budget, not a heap measurement.
const ENTRY_OVERHEAD_BYTES = 128

/**
 * A byte-bounded LRU cache for file contents used by FileEditTool operations.
 * Eviction discards only a reusable copy: reads always return the complete file.
 */
class FileReadCache {
  private cache = new Map<string, CachedFileData>()
  private readonly maxCacheSize = 1000
  private retainedBytes = 0

  /**
   * Reads a file with caching. Returns both content and encoding.
   * File identity, timestamps and size invalidate stale entries automatically.
   */
  readFile(filePath: string): { content: string; encoding: BufferEncoding } {
    const fs = getFsImplementation()

    // Get file stats for cache invalidation
    let stats
    try {
      stats = fs.statSync(filePath)
    } catch (error) {
      // File was deleted, remove from cache and re-throw
      this.invalidate(filePath)
      throw error
    }

    const cachedData = this.cache.get(filePath)

    // Check if we have valid cached data
    if (
      cachedData &&
      cachedData.mtime === stats.mtimeMs &&
      cachedData.ctime === stats.ctimeMs &&
      cachedData.size === stats.size &&
      cachedData.dev === stats.dev &&
      cachedData.ino === stats.ino
    ) {
      // Map iteration order is the LRU order. A hit keeps hot files resident.
      this.cache.delete(filePath)
      this.cache.set(filePath, cachedData)
      return {
        content: cachedData.content,
        encoding: cachedData.encoding,
      }
    }

    // Remove stale data before reading: a failed read must not retain it.
    this.invalidate(filePath)
    const encoding = detectFileEncoding(filePath)
    const content = fs
      .readFileSync(filePath, { encoding })
      .replaceAll('\r\n', '\n')

    const retainedBytes =
      (content.length + filePath.length) * 2 + ENTRY_OVERHEAD_BYTES
    // Large files remain fully readable without ejecting the small working set.
    if (retainedBytes > MAX_RETAINED_BYTES) {
      return { content, encoding }
    }

    while (
      this.cache.size >= this.maxCacheSize ||
      this.retainedBytes + retainedBytes > MAX_RETAINED_BYTES
    ) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.invalidate(oldest)
    }

    this.cache.set(filePath, {
      content,
      encoding,
      mtime: stats.mtimeMs,
      ctime: stats.ctimeMs,
      size: stats.size,
      dev: stats.dev,
      ino: stats.ino,
      retainedBytes,
    })
    this.retainedBytes += retainedBytes

    return { content, encoding }
  }

  /**
   * Clears the entire cache. Useful for testing or memory management.
   */
  clear(): void {
    this.cache.clear()
    this.retainedBytes = 0
  }

  /**
   * Removes a specific file from the cache.
   */
  invalidate(filePath: string): void {
    const entry = this.cache.get(filePath)
    if (entry) {
      this.retainedBytes -= entry.retainedBytes
      this.cache.delete(filePath)
    }
  }

  /**
   * Gets cache statistics for debugging/monitoring.
   */
  getStats(): {
    size: number
    entries: string[]
    retainedBytes: number
    maxBytes: number
  } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
      retainedBytes: this.retainedBytes,
      maxBytes: MAX_RETAINED_BYTES,
    }
  }
}

// Export a singleton instance
export const fileReadCache = new FileReadCache()
