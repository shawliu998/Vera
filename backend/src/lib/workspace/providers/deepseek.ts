import { ChatCompletionsProvider } from "./chatCompletions";
import type { ModelProviderConfig, ModelProviderDependencies } from "./types";

/** DeepSeek remains a first-class provider despite its wire compatibility. */
export class DeepSeekProvider extends ChatCompletionsProvider {
  constructor(
    config: ModelProviderConfig,
    dependencies: ModelProviderDependencies,
  ) {
    if (config.profile.provider !== "deepseek") {
      throw new Error("DeepSeek adapter received the wrong provider.");
    }
    super(config, dependencies);
  }
}
