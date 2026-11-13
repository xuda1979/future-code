import { stringWidth } from './stringWidth.js'
import { ByteBoundedCache } from '../utils/byteBoundedCache.js'

// During streaming, text grows but completed lines are immutable.
// Caching stringWidth per-line avoids re-measuring hundreds of
// unchanged lines on every token (~50x reduction in stringWidth calls).
const cache = new ByteBoundedCache<number>(4096, 1024 * 1024, () => 8)

export function lineWidth(line: string): number {
  const cached = cache.get(line)
  if (cached !== undefined) return cached

  const width = stringWidth(line)

  cache.set(line, width)
  return width
}
