import { marked, type Token } from 'marked'
import { ByteBoundedCache, estimateGraphBytes, flatStringCopy } from './byteBoundedCache.js'
import { hashContent } from './hash.js'

// Historical messages benefit from reuse on virtual-scroll remounts. Count
// alone is insufficient: 500 successive versions of a long reply can be huge.
const TOKEN_CACHE_BYTES = 8 * 1024 * 1024
const tokenCache = new ByteBoundedCache<Token[]>(
  500, TOKEN_CACHE_BYTES, tokens => estimateGraphBytes(tokens, TOKEN_CACHE_BYTES),
)

const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /

export function cachedLexer(content: string, cache = true): Token[] {
  // Preserve the existing plain-text fast path and parser behavior.
  if (!MD_SYNTAX_RE.test(content.length > 500 ? content.slice(0, 500) : content)) {
    return [{
      type: 'paragraph', raw: content, text: content,
      tokens: [{ type: 'text', raw: content, text: content }],
    } as Token]
  }
  // Streaming variants are rendered once and already memoized by their mounted
  // component. Do not hash or retain them in the history cache.
  if (!cache || content.length * 2 > TOKEN_CACHE_BYTES) return marked.lexer(content)
  const key = hashContent(content)
  const hit = tokenCache.get(key)
  if (hit) return hit
  // Token substrings must not pin a larger parent response/transcript string.
  const tokens = marked.lexer(flatStringCopy(content))
  tokenCache.set(key, tokens)
  return tokens
}

export function clearMarkdownTokenCache(): void { tokenCache.clear() }
export function getMarkdownTokenCacheStats() {
  return { entries: tokenCache.size, bytes: tokenCache.calculatedBytes, maxBytes: tokenCache.maxBytes }
}
