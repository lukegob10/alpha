import { openAiNativeDefaultModelId, openAiNativeModels } from "./openai-native.js"

// Sign in with ChatGPT uses the same public Responses model contract as API-key access.
// OAuth registration and account availability do not alter this supported model catalog.
export const openAiCodexModels = openAiNativeModels
export const openAiCodexDefaultModelId = openAiNativeDefaultModelId
export type OpenAiCodexModelId = keyof typeof openAiCodexModels
