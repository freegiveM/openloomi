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
  getModel,
  getVLMModel,
  createDynamicModel,
  getModelProvider,
  setAIUserContext,
  clearAIUserContext,
  getAIUserContext,
  routeModelCall,
  getRecommendedMode,
} from "@melandlabs/ai";

export {
  extractCloudAuthToken,
  setAIUserContextFromRequest,
} from "./request-context";

import { isTauriMode } from "@/lib/env/constants";
import { getModelProvider, getModel, getVLMModel } from "@melandlabs/ai";

// Lazy singletons — user LLM settings are read only when first accessed.
let _modelProvider: ReturnType<typeof getModelProvider> | undefined;
let _model: ReturnType<typeof getModel> | undefined;
let _vlmModel: ReturnType<typeof getVLMModel> | undefined;

export const modelProvider = () => {
  if (!_modelProvider) _modelProvider = getModelProvider(isTauriMode());
  return _modelProvider;
};
export const model = () => {
  if (!_model) _model = getModel(isTauriMode());
  return _model;
};
export const vlmModel = () => {
  if (!_vlmModel) _vlmModel = getVLMModel(isTauriMode());
  return _vlmModel;
};
