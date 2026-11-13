// Expose the baseline's private lexer without replacing its implementation.
// Uncalled React/UI imports are isolated; parsing and hashing remain real.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as sourceLoader from './source-loader.mjs';
const require = createRequire(import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if ((context.parentURL ?? '').endsWith('/src/components/Markdown.tsx')) {
    const stubs = {
      'react/compiler-runtime': 'export const c=()=>[];',
      'react': 'export default {}; export const Suspense=()=>{},use=()=>{},useMemo=()=>{},useRef=()=>{};',
      '../hooks/useSettings.js': 'export const useSettings=()=>({});',
      '../ink.js': 'export const Ansi=()=>{},Box=()=>{},useTheme=()=>[];',
      '../utils/cliHighlight.js': 'export const getCliHighlightPromise=()=>Promise.resolve(null);',
      '../utils/markdown.js': 'export const configureMarked=()=>{},formatToken=()=>{};',
      '../utils/messages.js': 'export const stripPromptXMLTags=s=>s;',
      './MarkdownTable.js': 'export const MarkdownTable=()=>{};',
    };
    if (stubs[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  }
  return sourceLoader.resolve(specifier, context, nextResolve);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/components/Markdown.tsx')) {
    const { transformSync } = require('@babel/core');
    const source = readFileSync(new URL(url), 'utf8') + '\nexport { cachedLexer };\nexport const clearMarkdownTokenCache=()=>tokenCache.clear();\nexport const getMarkdownTokenCacheStats=()=>({entries:tokenCache.size});\n';
    const { code } = transformSync(source, {
      filename: 'Markdown.tsx', configFile: false, babelrc: false, comments: false,
      presets: [require.resolve('@babel/preset-typescript')],
      plugins: [[require.resolve('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }]],
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return sourceLoader.load(url, context, nextLoad);
}
