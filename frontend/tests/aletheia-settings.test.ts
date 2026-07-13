import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
    DEFAULT_ALETHEIA_SETTINGS,
    matterTemplateId,
    normalizeAletheiaSettings,
} from "../src/aletheia/settingsModel.ts";
import { apiSettingsTransport } from "../src/aletheia/settingsTransport.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("normalization retains only settings with concrete frontend consumers", () => {
    const normalized = normalizeAletheiaSettings({
        ...DEFAULT_ALETHEIA_SETTINGS,
        theme: "Dark",
        density: "Compact",
        defaultModel: "ollama-legal",
        contextBudgetTokens: 8192,
        reasoning: "High",
        fastMode: true,
        approvalNotification: true,
        draftAutosave: "On",
    });

    assert.deepEqual(normalized, {
        ...DEFAULT_ALETHEIA_SETTINGS,
        theme: "Dark",
        density: "Compact",
        defaultModel: "ollama-legal",
        contextBudgetTokens: 8192,
        reasoning: "High",
        fastMode: true,
    });
    assert.equal("reasoning" in normalized, true);
    assert.equal("fastMode" in normalized, true);
    assert.equal("approvalNotification" in normalized, false);
    assert.equal("draftAutosave" in normalized, false);
});

test("default matter template maps to the create-matter API value", () => {
    assert.equal(matterTemplateId("Legal Matter Review"), "legal_matter_review");
    assert.equal(matterTemplateId("Compliance Impact Review"), "compliance_impact_review");
    assert.equal(matterTemplateId("Deal Due Diligence"), "deal_due_diligence");
});

test("settings transport sends a minimal conditional patch and reads response metadata", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({
            schemaVersion: "aletheia-client-settings-v1",
            version: 4,
            settings: { ...DEFAULT_ALETHEIA_SETTINGS, theme: "Dark" },
        }), {
            status: 200,
            headers: { "Content-Type": "application/json", ETag: '"settings-4"' },
        });
    };

    const document = await apiSettingsTransport.patch(
        { theme: "Dark" },
        { etag: '"settings-3"' },
    );

    const request = requests[0];
    assert.ok(request);
    assert.equal(request.url, "http://localhost:3001/aletheia/client-settings");
    assert.equal(request.init?.method, "PATCH");
    assert.equal(request.init?.body, JSON.stringify({ theme: "Dark" }));
    assert.equal(new Headers(request.init?.headers).get("if-match"), '"settings-3"');
    assert.equal(document.version, 4);
    assert.equal(document.etag, '"settings-4"');
    assert.equal(document.settings.theme, "Dark");

    await apiSettingsTransport.patch({ defaultModel: "" });
    assert.equal(requests[1]?.init?.body, JSON.stringify({ defaultModel: null }));
});

test("settings transport surfaces backend save errors", async () => {
    globalThis.fetch = async () => new Response(
        JSON.stringify({ detail: "settings version conflict" }),
        { status: 412, headers: { "Content-Type": "application/json" } },
    );

    await assert.rejects(
        () => apiSettingsTransport.patch({ density: "Compact" }),
        /settings version conflict/,
    );
});
