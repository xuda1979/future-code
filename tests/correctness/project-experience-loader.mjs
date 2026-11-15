// Run real memory builders/scanner/parser/file I/O without SDK/UI dependencies.
// Fixtures use JSON frontmatter (valid YAML), so only the YAML engine is replaced.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/utils/readFileInRange.ts')) return {
    format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true,
  };
  return nextLoad(url, context);
}
const data = source => ({ url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true });
export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL ?? '';
  if (!/\/src\/(memdir\/(memdir|memoryScan|teamMemPrompts)|services\/extractMemories\/prompts|utils\/(frontmatterParser|readFileInRange))\.ts$/.test(parent))
    return nextResolve(specifier, context);
  const stubs = {
    'bun:bundle': 'export const feature=()=>false;',
    '../utils/fsOperations.js': 'import fs from "node:fs"; export const getFsImplementation=()=>({...fs,...fs.promises,readFileSync:fs.readFileSync,readdir:p=>fs.promises.readdir(p,{withFileTypes:true})});',
    './paths.js': 'export const getAutoMemPath=()=>globalThis.__experienceDir; export const isAutoMemoryEnabled=()=>true;',
    './teamMemPaths.js': 'export const getTeamMemPath=()=>globalThis.__experienceDir+"team/";',
    '../bootstrap/state.js': 'export const getKairosActive=()=>false; export const getOriginalCwd=()=>"/test/project";',
    '../services/analytics/growthbook.js': 'export const getFeatureValue_CACHED_MAY_BE_STALE=(_k,v)=>v;',
    '../services/analytics/index.js': 'export const logEvent=()=>{};',
    '../tools/GrepTool/prompt.js': 'export const GREP_TOOL_NAME="Grep";',
    '../tools/REPLTool/constants.js': 'export const isReplModeEnabled=()=>false;',
    '../utils/debug.js': 'export const logForDebugging=()=>{};',
    './debug.js': 'export const logForDebugging=()=>{};',
    './yaml.js': 'export const parseYaml=JSON.parse;',
    '../utils/embeddedTools.js': 'export const hasEmbeddedSearchTools=()=>false;',
    '../utils/envUtils.js': 'export const isEnvTruthy=v=>v==="1"||v==="true";',
    '../utils/format.js': 'export const formatFileSize=n=>String(n);',
    './format.js': 'export const formatFileSize=n=>String(n);',
    '../utils/sessionStorage.js': 'export const getProjectDir=()=>"/test/project";',
    '../utils/settings/settings.js': 'export const getInitialSettings=()=>({});',
  };
  if (stubs[specifier]) return data(stubs[specifier]);
  if (parent.endsWith('/src/services/extractMemories/prompts.ts') && specifier.includes('/tools/')) {
    const name = specifier.includes('/BashTool/') ? 'BASH_TOOL_NAME' : specifier.includes('/FileEditTool/') ? 'FILE_EDIT_TOOL_NAME'
      : specifier.includes('/FileReadTool/') ? 'FILE_READ_TOOL_NAME' : specifier.includes('/FileWriteTool/') ? 'FILE_WRITE_TOOL_NAME'
      : specifier.includes('/GlobTool/') ? 'GLOB_TOOL_NAME' : 'GREP_TOOL_NAME';
    return data(`export const ${name}="${name}";`);
  }
  if (specifier.endsWith('.js')) return { url: new URL(specifier.replace(/\.js$/, '.ts'), parent).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
