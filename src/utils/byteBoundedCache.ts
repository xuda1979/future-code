type Entry<Value> = {
  key: string
  value: Value
  bytes: number
  previous: Entry<Value> | undefined
  next: Entry<Value> | undefined
}

/** LRU for disposable derived data. Charges are conservative estimates, not RSS. */
export class ByteBoundedCache<Value> {
  private entries = new Map<string, Entry<Value>>()
  private bytes = 0
  private oldest: Entry<Value> | undefined
  private newest: Entry<Value> | undefined
  readonly maxEntries: number
  readonly maxBytes: number
  private sizeOf: (value: Value) => number

  constructor(
    maxEntries: number,
    maxBytes: number,
    sizeOf: (value: Value) => number,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('Cache limits must be positive safe integers')
    }
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
    this.sizeOf = sizeOf
  }

  get(key: string): Value | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry !== this.newest) {
      // Relink existing nodes instead of deleting/reinserting Map keys on every
      // visible-line hit. This avoids Map churn and allocation on hot frames.
      this.unlink(entry)
      this.append(entry)
    }
    return entry.value
  }

  set(key: string, value: Value): void {
    // Include the key, Map entry, wrapper object and pointers in the charge.
    const valueBytes = this.sizeOf(value)
    const bytes = valueBytes + key.length * 2 + 192
    const previous = this.entries.get(key)
    if (previous) {
      this.entries.delete(key)
      this.unlink(previous)
      this.bytes -= previous.bytes
    }
    // Oversized/invalid entries must not evict a useful small working set.
    if (!Number.isSafeInteger(valueBytes) || valueBytes < 0 ||
        !Number.isSafeInteger(bytes) || bytes > this.maxBytes) return
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.oldest!
      this.bytes -= oldest.bytes
      this.entries.delete(oldest.key)
      this.unlink(oldest)
    }
    // A line can be a substring of a many-MB response. A flat, lossless string
    // copy prevents a small key from pinning that entire backing string.
    const flatKey = flatStringCopy(key)
    const entry = { key: flatKey, value, bytes, previous: undefined, next: undefined }
    this.entries.set(flatKey, entry)
    this.append(entry)
    this.bytes += bytes
  }

  clear(): void {
    this.entries.clear()
    this.bytes = 0
    this.oldest = undefined
    this.newest = undefined
  }

  private unlink(entry: Entry<Value>): void {
    if (entry.previous) entry.previous.next = entry.next
    else this.oldest = entry.next
    if (entry.next) entry.next.previous = entry.previous
    else this.newest = entry.previous
  }

  private append(entry: Entry<Value>): void {
    entry.previous = this.newest
    entry.next = undefined
    if (this.newest) this.newest.next = entry
    else this.oldest = entry
    this.newest = entry
  }

  get size(): number { return this.entries.size }
  get calculatedBytes(): number { return this.bytes }
}

/** Keep normal ASCII/UTF-8 strings compact, without replacing lone surrogates. */
export function flatStringCopy(value: string): string {
  const encoding = typeof value.isWellFormed === 'function' && value.isWellFormed()
    ? 'utf8' : 'utf16le'
  return Buffer.from(value, encoding).toString(encoding)
}

/**
 * Charge a JSON-like derived graph, including nested token strings/objects.
 * Shared objects/cycles are counted once; string fields are charged separately.
 * Stop at the budget so an uncacheable parse does not require another full walk.
 */
export function estimateGraphBytes(value: unknown, limit: number): number {
  const seen = new Set<object>()
  const pending: unknown[] = [value]
  let bytes = 0
  while (pending.length && bytes <= limit) {
    const item = pending.pop()
    if (typeof item === 'string') {
      bytes += item.length * 2 + 24
    } else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item)
      bytes += 64
      for (const key of Object.keys(item)) {
        bytes += key.length * 2 + 16
        const child = (item as Record<string, unknown>)[key]
        // Charge strings immediately to avoid queuing a huge token array.
        if (typeof child === 'string') bytes += child.length * 2 + 24
        else if (child && typeof child === 'object') pending.push(child)
        if (bytes > limit) break
      }
    } else {
      bytes += 8
    }
  }
  return bytes
}
