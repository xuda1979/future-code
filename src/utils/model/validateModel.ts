// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { MODEL_ALIASES } from './aliases.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getAPIProvider } from './providers.js'
import { sideQuery } from '../sideQuery.js'
import {
  NotFoundError,
  APIError,
  APIConnectionError,
  AuthenticationError,
} from '@future/sdk'
import { getModelStrings } from './modelStrings.js'
import { createHash } from 'node:crypto'
import { readModelEndpoint } from './modelEndpoints.js'
import { withModelValidationDeadline } from './validationDeadline.js'

// Cache valid models to avoid repeated API calls
const validModelCache = new Map<string, boolean>()

/**
 * Validates a model by attempting an actual API call.
 */
export async function validateModel(
  model: string,
  signal?: AbortSignal,
): Promise<{ valid: boolean; error?: string }> {
  const normalizedModel = model.trim()

  // Empty model is invalid
  if (!normalizedModel) {
    return { valid: false, error: 'Model name cannot be empty' }
  }

  // Check against availableModels allowlist before any API call
  if (!isModelAllowed(normalizedModel)) {
    return {
      valid: false,
      error: `Model '${normalizedModel}' is not in the list of available models`,
    }
  }

  // Check if it's a known alias (these are always valid)
  const lowerModel = normalizedModel.toLowerCase()
  if ((MODEL_ALIASES as readonly string[]).includes(lowerModel)) {
    return { valid: true }
  }

  // Check if it matches FUTURE_CUSTOM_MODEL_OPTION (pre-validated by the user)
  const endpoint = readModelEndpoint(normalizedModel)
  if (!endpoint && normalizedModel === process.env.FUTURE_CUSTOM_MODEL_OPTION) {
    return { valid: true }
  }

  // Model IDs alone are not identities: re-adding the same ID may replace
  // its endpoint or key. Never reuse the previous provider's successful check.
  const validationIdentity = () => createHash('sha256').update(JSON.stringify([
    normalizedModel, getAPIProvider(), process.env.FUTURE_BASE_URL,
    process.env.FUTURE_API_KEY, process.env.FUTURE_AUTH_TOKEN,
    process.env.FUTURE_CUSTOM_HEADERS, readModelEndpoint(normalizedModel),
  ])).digest('hex')
  const cacheKey = validationIdentity()
  if (signal?.aborted) return { valid: false, error: 'Model validation cancelled.' }
  if (validModelCache.has(cacheKey)) {
    return { valid: true }
  }


  // Try to make an actual API call with minimal parameters
  try {
    await withModelValidationDeadline(validationSignal => sideQuery({
      model: normalizedModel,
      max_tokens: 1,
      maxRetries: 0,
      querySource: 'model_validation',
      signal: validationSignal,
      thinking: false,
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hi',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    }), signal)

    // If we got here, the model is valid
    if (signal?.aborted) return { valid: false, error: 'Model validation cancelled.' }
    if (validationIdentity() !== cacheKey) return { valid: false, error: 'Model endpoint changed during validation. The current model was kept; try again.' }
    if (validModelCache.size >= 256) validModelCache.clear()
    validModelCache.set(cacheKey, true)
    return { valid: true }
  } catch (error) {
    return handleValidationError(error, normalizedModel, Boolean(endpoint))
  }
}

function handleValidationError(
  error: unknown,
  modelName: string,
  privateEndpoint = false,
): { valid: boolean; error: string } {
  // NotFoundError (404) means the model doesn't exist
  if (error instanceof NotFoundError) {
    const fallback = get3PFallbackSuggestion(modelName)
    const suggestion = fallback ? `. Try '${fallback}' instead` : ''
    return {
      valid: false,
      error: `Model '${modelName}' not found${suggestion}`,
    }
  }

  // For other API errors, provide context-specific messages
  if (error instanceof APIError) {
    if (error instanceof AuthenticationError) {
      return {
        valid: false,
        error: 'Authentication failed. Please check your API credentials.',
      }
    }

    if (error instanceof APIConnectionError) {
      return {
        valid: false,
        error: 'Network error. Please check your internet connection.',
      }
    }

    // Check error body for model-specific errors
    const errorBody = error.error as unknown
    if (
      errorBody &&
      typeof errorBody === 'object' &&
      'type' in errorBody &&
      errorBody.type === 'not_found_error' &&
      'message' in errorBody &&
      typeof errorBody.message === 'string' &&
      errorBody.message.includes('model:')
    ) {
      return { valid: false, error: `Model '${modelName}' not found` }
    }

    // Generic API error
    return { valid: false, error: privateEndpoint ? `API error (HTTP ${error.status ?? 'unknown'}). Check the saved endpoint and credentials.` : `API error: ${error.message}` }
  }

  // For unknown errors, be safe and reject
  const errorMessage = error instanceof Error ? error.message : String(error)
  return {
    valid: false,
    error: `Unable to validate model: ${errorMessage}`,
  }
}

// @[MODEL LAUNCH]: Add a fallback suggestion chain for the new model → previous version
/**
 * Suggest a fallback model for 3P users when the selected model is unavailable.
 */
function get3PFallbackSuggestion(model: string): string | undefined {
  if (getAPIProvider() === 'firstParty') {
    return undefined
  }
  const lowerModel = model.toLowerCase()
  if (lowerModel.includes('opus-4-6') || lowerModel.includes('opus_4_6')) {
    return getModelStrings().opus41
  }
  if (lowerModel.includes('sonnet-4-6') || lowerModel.includes('sonnet_4_6')) {
    return getModelStrings().sonnet45
  }
  if (lowerModel.includes('sonnet-4-5') || lowerModel.includes('sonnet_4_5')) {
    return getModelStrings().sonnet40
  }
  return undefined
}
