/**
 * AI Layer barrel export.
 *
 * Re-exports runtime helpers from `@melandlabs/ai` and local request-context
 * helpers. The `modelProvider`, `model`, `vlmModel` singletons delegate to
 * `@melandlabs/ai` at call time so user LLM settings can be read lazily.
 */

export {
  estimateTokens,
  getInputCredits,
  getOutputCredits,
  getTotalCredits,
  INPUT_TOKENS_PER_CREDIT,
  OUTPUT_TOKENS_PER_CREDIT,
  MODEL_PRICING,
  getModelPricing,
  getModelMultiplier,
  CREDIT_VALUE_USD,
  calculateImageCredits,
  getImageModelPricing,
  IMAGE_MODEL_PRICING,
  getCanonicalImageModel,
  calculateInputCredits,
  calculateOutputCredits,
  calculateTotalCredits,
  COMPACTION_SOFT_RATIO,
  COMPACTION_HARD_RATIO,
  COMPACTION_EMERGENCY_RATIO,
  COMPACTION_MODEL,
  buildCompactionPrompt,
  triggerCompaction,
  triggerCompactionAsync,
  prepareConversationWindows,
  estimateConversationTokens,
  getConversationBucket,
  DEFAULT_CONVERSATION_WINDOW_CONFIG,
  routeModelCall,
  getRecommendedMode,
} from "@melandlabs/ai";

export {
  createDynamicModel,
  getModel,
  getModelProvider,
  getVLMModel,
} from "./provider-model";

export {
  extractCloudAuthToken,
  setAIUserContextFromRequest,
} from "./request-context";

import { isTauriMode } from "@/lib/env/constants";
import {
  clearAIUserContext as clearPackageAIUserContext,
  getAIUserContext,
  setAIUserContext as setPackageAIUserContext,
  type AIUserContext,
} from "@melandlabs/ai";
import {
  clearActiveLlmProviderConfig,
  getModelProvider,
  getModel,
  getVLMModel,
} from "./provider-model";

export function setAIUserContext(context: AIUserContext | null): void {
  setPackageAIUserContext(context);
}

export function clearAIUserContext(): void {
  clearPackageAIUserContext();
  clearActiveLlmProviderConfig();
}

export { getAIUserContext };

export const modelProvider = () => {
  return getModelProvider(isTauriMode());
};
export const model = () => {
  return getModel(isTauriMode());
};
export const vlmModel = () => {
  return getVLMModel(isTauriMode());
};
