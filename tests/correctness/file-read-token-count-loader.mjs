// Exercise the real token-count service; replace unrelated CLI imports and
// inject only client initialization and SDK transport boundaries.
export async function resolve(specifier, context, nextResolve) {
  if (!context.parentURL?.endsWith('/src/services/tokenEstimation.ts')) return nextResolve(specifier, context);
  const state = 'globalThis.__fileReadTokenCountTest';
  const stubs = {
    'src/utils/model/providers.js': `export const getAPIProvider=()=>${state}.provider ?? 'firstParty';`,
    '../constants/betas.js': 'export const VERTEX_COUNT_TOKENS_ALLOWED_BETAS=new Set();',
    '../utils/betas.js': 'export const getModelBetas=()=>[];',
    '../utils/envUtils.js': 'export const getVertexRegionForModel=()=>"test-region"; export const isEnvTruthy=()=>false;',
    '../utils/log.js': `export const logError=error=>${state}.errors.push(error);`,
    '../utils/messages.js': 'export const normalizeAttachmentForAPI=value=>value;',
    '../utils/model/bedrock.js': `export const createBedrockRuntimeClient=()=>${state}.init(); export const isFoundationModel=()=>${state}.foundation !== false; export const getInferenceProfileBackingModel=async()=>{ ${state}.metadataCalls++; return "test-model"; };`,
    '../utils/model/model.js': 'export const getDefaultSonnetModel=()=>"test-model"; export const getMainLoopModel=()=>"test-model"; export const getSmallFastModel=()=>"test-model"; export const normalizeModelStringForAPI=x=>x;',
    '../utils/slowOperations.js': 'export const jsonStringify=JSON.stringify;',
    '../utils/toolSearch.js': 'export const isToolReferenceBlock=()=>false;',
    './api/future.js': 'export const getAPIMetadata=()=>({}); export const getExtraBodyParams=()=>({});',
    './api/client.js': `export const getFutureClient=()=>${state}.init();`,
    './vcr.js': 'export const withTokenCountVCR=(_messages,_tools,run)=>run();',
    '@aws-sdk/client-bedrock-runtime': 'export class CountTokensCommand {constructor(input){this.input=input;}}',
  };
  return stubs[specifier] === undefined ? nextResolve(specifier, context) : {
    url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true,
  };
}
