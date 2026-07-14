import { ChatCompletionsProvider } from "./chatCompletions";
import type { ModelProviderConfig, ModelProviderDependencies } from "./types";

export class GenericOpenAICompatibleProvider extends ChatCompletionsProvider {
  constructor(
    config: ModelProviderConfig,
    dependencies: ModelProviderDependencies,
  ) {
    if (config.profile.provider !== "openai_compatible") {
      throw new Error(
        "Generic OpenAI-compatible adapter received the wrong provider.",
      );
    }
    if (
      !config.expectedBinding.normalizedBaseUrl ||
      !config.expectedBinding.canonicalOrigin
    ) {
      throw new Error(
        "Generic OpenAI-compatible adapter requires an attested endpoint binding.",
      );
    }
    super(config, dependencies);
  }
}
