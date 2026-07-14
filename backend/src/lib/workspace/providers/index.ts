import { AnthropicMessagesProvider } from "./anthropic";
import { DeepSeekProvider } from "./deepseek";
import { GeminiNativeProvider } from "./gemini";
import { OpenAIResponsesProvider } from "./openai";
import { GenericOpenAICompatibleProvider } from "./openaiCompatible";
import type {
  ModelProvider,
  ModelProviderConfig,
  ModelProviderDependencies,
} from "./types";

export * from "./types";
export {
  AnthropicMessagesProvider,
  DeepSeekProvider,
  GeminiNativeProvider,
  GenericOpenAICompatibleProvider,
  OpenAIResponsesProvider,
};

/**
 * The returned adapter is permanently bound to this exact profile/binding
 * snapshot. generate() cannot receive or accidentally reuse another profile.
 */
export function createModelProvider(
  config: ModelProviderConfig,
  dependencies: ModelProviderDependencies,
): ModelProvider {
  if (config.profile.provider === "openai") {
    return new OpenAIResponsesProvider(config, dependencies);
  }
  if (config.profile.provider === "deepseek") {
    return new DeepSeekProvider(config, dependencies);
  }
  if (config.profile.provider === "anthropic") {
    return new AnthropicMessagesProvider(config, dependencies);
  }
  if (config.profile.provider === "gemini") {
    return new GeminiNativeProvider(config, dependencies);
  }
  return new GenericOpenAICompatibleProvider(config, dependencies);
}
