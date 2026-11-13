// Load the actual TypeScript rendering modules under Node, without the CLI.
// Only debug logging is isolated. Tokenization, parsing, Unicode, screen pools,
// byte accounting and LRU behavior are production code and real dependencies.
import { existsSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? '';
  if (parent.includes('/src/') && /(?:^|\/)debug\.js$/.test(specifier)) {
    return { url: 'data:text/javascript,export const logForDebugging=()=>{};', shortCircuit: true };
  }
  if (parent.includes('/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const url = new URL(specifier.slice(0, -3) + '.ts', parent);
    if (existsSync(url)) return { url: url.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.includes('/src/') && url.endsWith('.ts')) {
    return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
  }
  return nextLoad(url, context);
}
