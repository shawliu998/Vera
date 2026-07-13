import path from "node:path";
import {
  LocalModelScheduler,
  type LocalModelDefinition,
} from "./localModelScheduler";

let singleton: LocalModelScheduler | null = null;
let configured = false;

function listEnv(name: string) {
  return (process.env[name] ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function configuredDefinitions(): LocalModelDefinition[] {
  const raw = process.env.ALETHEIA_LOCAL_MODELS_JSON?.trim();
  if (!raw) {
    const model =
      process.env.ALETHEIA_LOCAL_MODEL_NAME?.trim() ||
      process.env.ALETHEIA_OLLAMA_MODEL?.trim();
    if (!model) return [];
    const configuredAdapter = process.env.ALETHEIA_LOCAL_MODEL_ADAPTER?.trim();
    if (
      configuredAdapter &&
      configuredAdapter !== "ollama" &&
      configuredAdapter !== "openai-compatible"
    ) {
      throw new Error(
        "ALETHEIA_LOCAL_MODEL_ADAPTER must be ollama or openai-compatible",
      );
    }
    return [
      {
        id: process.env.ALETHEIA_LOCAL_MODEL_ID?.trim() || "default-local",
        adapter:
          configuredAdapter === "openai-compatible"
            ? "openai-compatible"
            : "ollama",
        endpoint:
          process.env.ALETHEIA_LOCAL_MODEL_ENDPOINT?.trim() ||
          process.env.ALETHEIA_OLLAMA_ENDPOINT?.trim() ||
          "http://127.0.0.1:11434",
        model,
        revision:
          process.env.ALETHEIA_LOCAL_MODEL_REVISION?.trim() || undefined,
        contextWindowTokens: Number(
          process.env.ALETHEIA_LOCAL_MODEL_CONTEXT_TOKENS ?? 32_768,
        ),
        maxOutputTokens: Number(
          process.env.ALETHEIA_LOCAL_MODEL_MAX_OUTPUT_TOKENS ?? 4_096,
        ),
        concurrency: Number(process.env.ALETHEIA_LOCAL_MODEL_CONCURRENCY ?? 1),
        queueLimit: Number(process.env.ALETHEIA_LOCAL_MODEL_QUEUE_LIMIT ?? 16),
      },
    ];
  }
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) {
    throw new Error("ALETHEIA_LOCAL_MODELS_JSON exceeds 256 KB");
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length > 16) {
    throw new Error(
      "ALETHEIA_LOCAL_MODELS_JSON must contain at most 16 models",
    );
  }
  return parsed as LocalModelDefinition[];
}

export function localModelScheduler() {
  if (!singleton) {
    singleton = new LocalModelScheduler({
      managedExecutableAllowlist: listEnv(
        "ALETHEIA_LOCAL_MODEL_EXECUTABLE_ALLOWLIST",
      ),
      managedEnvironmentAllowlist: (
        process.env.ALETHEIA_LOCAL_MODEL_ENV_ALLOWLIST ?? ""
      )
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    });
  }
  if (!configured) {
    for (const definition of configuredDefinitions()) {
      singleton.registerModel(definition);
    }
    configured = true;
  }
  return singleton;
}

export async function startConfiguredLocalModels() {
  const scheduler = localModelScheduler();
  if (process.env.ALETHEIA_LOCAL_MODEL_AUTOSTART !== "true") {
    return scheduler.snapshots();
  }
  return scheduler.startAll();
}

export async function closeLocalModelRuntime() {
  if (!singleton) return;
  await singleton.close();
  singleton = null;
  configured = false;
}
