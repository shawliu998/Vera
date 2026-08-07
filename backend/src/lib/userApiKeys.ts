import crypto from "crypto";
import { z } from "zod";
import { createServerSupabase } from "./supabase";
import type { UserApiKeys } from "./llm";

type Db = ReturnType<typeof createServerSupabase>;
export type ApiKeyProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "deepseek"
    | "kimi"
    | "zhipu"
    | "openrouter"
    | "courtlistener";
export type ApiKeySource = "user" | "env" | null;
export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources: Record<ApiKeyProvider, ApiKeySource>;
};

export type EpoOpsCredentials = {
    consumerKey: string;
    consumerSecret: string;
};

export type EpoOpsCredentialStatus = {
    configured: boolean;
    source: ApiKeySource;
};

type EncryptedKeyRow = {
    provider: string;
    encrypted_key: string;
    iv: string;
    auth_tag: string;
};

const EPO_OPS_PROVIDER = "epo_ops" as const;
const epoOpsCredentialsSchema = z
    .object({
        consumerKey: z.string().trim().min(1).max(512),
        consumerSecret: z.string().trim().min(1).max(512),
    })
    .strict();
const epoOpsCredentialEnvelopeSchema = z
    .object({
        schema_version: z.literal("epo_ops_credentials_v1"),
        consumer_key: z.string().trim().min(1).max(512),
        consumer_secret: z.string().trim().min(1).max(512),
    })
    .strict();

const PROVIDERS: ApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "deepseek",
    "kimi",
    "zhipu",
    "openrouter",
    "courtlistener",
];

function envApiKey(provider: ApiKeyProvider): string | null {
    switch (provider) {
        case "claude":
            return (
                process.env.ANTHROPIC_API_KEY?.trim() ||
                process.env.CLAUDE_API_KEY?.trim() ||
                null
            );
        case "gemini":
            return process.env.GEMINI_API_KEY?.trim() || null;
        case "openai":
            return process.env.OPENAI_API_KEY?.trim() || null;
        case "deepseek":
            return process.env.DEEPSEEK_API_KEY?.trim() || null;
        case "kimi":
            return process.env.MOONSHOT_API_KEY?.trim() || null;
        case "zhipu":
            return (
                process.env.ZHIPU_API_KEY?.trim() ||
                process.env.BIGMODEL_API_KEY?.trim() ||
                null
            );
        case "openrouter":
            return process.env.OPENROUTER_API_KEY?.trim() || null;
        case "courtlistener":
            return process.env.COURTLISTENER_API_TOKEN?.trim() || null;
        default:
            return null;
    }
}
export function hasEnvApiKey(provider: ApiKeyProvider): boolean {
    return !!envApiKey(provider);
}

function envEpoOpsCredentials(): EpoOpsCredentials | null {
    const consumerKey = process.env.EPO_OPS_CONSUMER_KEY?.trim() || null;
    const consumerSecret =
        process.env.EPO_OPS_CONSUMER_SECRET?.trim() || null;
    if (!consumerKey || !consumerSecret) return null;
    return epoOpsCredentialsSchema.parse({ consumerKey, consumerSecret });
}

export function hasEnvEpoOpsCredentials(): boolean {
    return envEpoOpsCredentials() !== null;
}

function encryptionKey(): Buffer {
    const secret = process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error("USER_API_KEYS_ENCRYPTION_SECRET is not configured");
    }
    return crypto.scryptSync(secret, "mike-user-api-keys-v1", 32);
}

function encrypt(value: string): Omit<EncryptedKeyRow, "provider"> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted_key: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        auth_tag: cipher.getAuthTag().toString("base64"),
    };
}

function decrypt(row: EncryptedKeyRow): string | null {
    try {
        const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            encryptionKey(),
            Buffer.from(row.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(row.encrypted_key, "base64")),
            decipher.final(),
        ]);
        return decrypted.toString("utf8");
    } catch (err) {
        console.error("[user-api-keys] failed to decrypt stored key", {
            provider: row.provider,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

function isProvider(value: string): value is ApiKeyProvider {
    return (PROVIDERS as string[]).includes(value);
}

export function normalizeApiKeyProvider(value: string): ApiKeyProvider | null {
    return isProvider(value) ? value : null;
}

export async function getUserApiKeyStatus(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<ApiKeyStatus> {
    const status: ApiKeyStatus = {
        claude: false,
        gemini: false,
        openai: false,
        deepseek: false,
        kimi: false,
        zhipu: false,
        openrouter: false,
        courtlistener: false,
        sources: {
            claude: null,
            gemini: null,
            openai: null,
            deepseek: null,
            kimi: null,
            zhipu: null,
            openrouter: null,
            courtlistener: null,
        },
    };

    for (const provider of PROVIDERS) {
        if (hasEnvApiKey(provider)) {
            status[provider] = true;
            status.sources[provider] = "env";
        }
    }

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider")
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of data ?? []) {
        const provider = normalizeApiKeyProvider(String(row.provider));
        if (provider && !status[provider]) {
            status[provider] = true;
            status.sources[provider] = "user";
        }
    }

    return status;
}

export async function getUserApiKeys(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<UserApiKeys> {
    const apiKeys: UserApiKeys = {
        claude: envApiKey("claude"),
        gemini: envApiKey("gemini"),
        openai: envApiKey("openai"),
        deepseek: envApiKey("deepseek"),
        kimi: envApiKey("kimi"),
        zhipu: envApiKey("zhipu"),
        openrouter: envApiKey("openrouter"),
        courtlistener: envApiKey("courtlistener"),
    };

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider, encrypted_key, iv, auth_tag")
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of (data ?? []) as EncryptedKeyRow[]) {
        const provider = normalizeApiKeyProvider(row.provider);
        if (!provider) continue;
        if (apiKeys[provider]?.trim()) continue;
        apiKeys[provider] = decrypt(row);
    }

    return apiKeys;
}

export async function saveUserApiKey(
    userId: string,
    provider: ApiKeyProvider,
    value: string | null,
    db: Db = createServerSupabase(),
): Promise<void> {
    const normalized = value?.trim() || null;
    if (!normalized) {
        const { error } = await db
            .from("user_api_keys")
            .delete()
            .eq("user_id", userId)
            .eq("provider", provider);
        if (error) throw error;
        return;
    }

    const { error } = await db.from("user_api_keys").upsert(
        {
            user_id: userId,
            provider,
            ...encrypt(normalized),
            updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" },
    );
    if (error) throw error;
}

async function getStoredEpoOpsCredentials(
    userId: string,
    db: Db,
): Promise<EpoOpsCredentials | null> {
    const { data, error } = await db
        .from("user_api_keys")
        .select("provider, encrypted_key, iv, auth_tag")
        .eq("user_id", userId)
        .eq("provider", EPO_OPS_PROVIDER)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const plaintext = decrypt(data as EncryptedKeyRow);
    if (!plaintext) return null;
    try {
        const envelope = epoOpsCredentialEnvelopeSchema.parse(
            JSON.parse(plaintext),
        );
        return {
            consumerKey: envelope.consumer_key,
            consumerSecret: envelope.consumer_secret,
        };
    } catch {
        return null;
    }
}

/** Resolve only the current user's EPO OPS pair; never expose this via status APIs. */
export async function getUserEpoOpsCredentials(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<EpoOpsCredentials | null> {
    return envEpoOpsCredentials() ?? getStoredEpoOpsCredentials(userId, db);
}

export async function getUserEpoOpsCredentialStatus(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<EpoOpsCredentialStatus> {
    if (hasEnvEpoOpsCredentials()) return { configured: true, source: "env" };
    const credentials = await getStoredEpoOpsCredentials(userId, db);
    return {
        configured: credentials !== null,
        source: credentials ? "user" : null,
    };
}

export async function saveUserEpoOpsCredentials(
    userId: string,
    value: EpoOpsCredentials | null,
    db: Db = createServerSupabase(),
): Promise<void> {
    if (!value) {
        const { error } = await db
            .from("user_api_keys")
            .delete()
            .eq("user_id", userId)
            .eq("provider", EPO_OPS_PROVIDER);
        if (error) throw error;
        return;
    }
    const credentials = epoOpsCredentialsSchema.parse(value);
    const envelope = JSON.stringify({
        schema_version: "epo_ops_credentials_v1",
        consumer_key: credentials.consumerKey,
        consumer_secret: credentials.consumerSecret,
    });
    const { error } = await db.from("user_api_keys").upsert(
        {
            user_id: userId,
            provider: EPO_OPS_PROVIDER,
            ...encrypt(envelope),
            updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" },
    );
    if (error) throw error;
}
