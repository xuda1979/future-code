// Content for the future-api bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import csharpFutureApi from './future-api/csharp/future-api.md'
import curlExamples from './future-api/curl/examples.md'
import goFutureApi from './future-api/go/future-api.md'
import javaFutureApi from './future-api/java/future-api.md'
import phpFutureApi from './future-api/php/future-api.md'
import pythonAgentSdkPatterns from './future-api/python/agent-sdk/patterns.md'
import pythonAgentSdkReadme from './future-api/python/agent-sdk/README.md'
import pythonFutureApiBatches from './future-api/python/future-api/batches.md'
import pythonFutureApiFilesApi from './future-api/python/future-api/files-api.md'
import pythonFutureApiReadme from './future-api/python/future-api/README.md'
import pythonFutureApiStreaming from './future-api/python/future-api/streaming.md'
import pythonFutureApiToolUse from './future-api/python/future-api/tool-use.md'
import rubyFutureApi from './future-api/ruby/future-api.md'
import skillPrompt from './future-api/SKILL.md'
import sharedErrorCodes from './future-api/shared/error-codes.md'
import sharedLiveSources from './future-api/shared/live-sources.md'
import sharedModels from './future-api/shared/models.md'
import sharedPromptCaching from './future-api/shared/prompt-caching.md'
import sharedToolUseConcepts from './future-api/shared/tool-use-concepts.md'
import typescriptAgentSdkPatterns from './future-api/typescript/agent-sdk/patterns.md'
import typescriptAgentSdkReadme from './future-api/typescript/agent-sdk/README.md'
import typescriptFutureApiBatches from './future-api/typescript/future-api/batches.md'
import typescriptFutureApiFilesApi from './future-api/typescript/future-api/files-api.md'
import typescriptFutureApiReadme from './future-api/typescript/future-api/README.md'
import typescriptFutureApiStreaming from './future-api/typescript/future-api/streaming.md'
import typescriptFutureApiToolUse from './future-api/typescript/future-api/tool-use.md'

// @[MODEL LAUNCH]: Update the model IDs/names below. These are substituted into {{VAR}}
// placeholders in the .md files at runtime before the skill prompt is sent.
// After updating these constants, manually update the two files that still hardcode models:
//   - future-api/SKILL.md (Current Models pricing table)
//   - future-api/shared/models.md (full model catalog with legacy versions and alias mappings)
export const SKILL_MODEL_VARS = {
  OPUS_ID: 'future-opus-4-6',
  OPUS_NAME: 'Future Opus 4.6',
  SONNET_ID: 'future-sonnet-4-6',
  SONNET_NAME: 'Future Sonnet 4.6',
  HAIKU_ID: 'future-haiku-4-5',
  HAIKU_NAME: 'Future Haiku 4.5',
  // Previous Sonnet ID — used in "do not append date suffixes" example in SKILL.md.
  PREV_SONNET_ID: 'future-sonnet-4-5',
} satisfies Record<string, string>

export const SKILL_PROMPT: string = skillPrompt

export const SKILL_FILES: Record<string, string> = {
  'csharp/future-api.md': csharpFutureApi,
  'curl/examples.md': curlExamples,
  'go/future-api.md': goFutureApi,
  'java/future-api.md': javaFutureApi,
  'php/future-api.md': phpFutureApi,
  'python/agent-sdk/README.md': pythonAgentSdkReadme,
  'python/agent-sdk/patterns.md': pythonAgentSdkPatterns,
  'python/future-api/README.md': pythonFutureApiReadme,
  'python/future-api/batches.md': pythonFutureApiBatches,
  'python/future-api/files-api.md': pythonFutureApiFilesApi,
  'python/future-api/streaming.md': pythonFutureApiStreaming,
  'python/future-api/tool-use.md': pythonFutureApiToolUse,
  'ruby/future-api.md': rubyFutureApi,
  'shared/error-codes.md': sharedErrorCodes,
  'shared/live-sources.md': sharedLiveSources,
  'shared/models.md': sharedModels,
  'shared/prompt-caching.md': sharedPromptCaching,
  'shared/tool-use-concepts.md': sharedToolUseConcepts,
  'typescript/agent-sdk/README.md': typescriptAgentSdkReadme,
  'typescript/agent-sdk/patterns.md': typescriptAgentSdkPatterns,
  'typescript/future-api/README.md': typescriptFutureApiReadme,
  'typescript/future-api/batches.md': typescriptFutureApiBatches,
  'typescript/future-api/files-api.md': typescriptFutureApiFilesApi,
  'typescript/future-api/streaming.md': typescriptFutureApiStreaming,
  'typescript/future-api/tool-use.md': typescriptFutureApiToolUse,
}
