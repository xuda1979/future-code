// Load the production cache under Node without the unrelated CLI dependency graph.
// Only encoding detection and the filesystem boundary are replaced.
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/utils/fileReadCache.ts')) {
    const stubs = {
      './file.js': 'export const detectFileEncoding=p=>globalThis.__fileReadCacheTest?.encoding(p) ?? "utf8";',
      './fsOperations.js': 'import * as fs from "node:fs"; export const getFsImplementation=()=>globalThis.__fileReadCacheTest?.fs ?? fs;',
    }
    if (stubs[specifier]) {
      return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
