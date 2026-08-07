import assert from "node:assert/strict";
import test from "node:test";

import {
    getModelProvider,
    isModelAvailable,
    modelGroupToProvider,
    providerLabel,
} from "./modelAvailability";

test("maps current GLM models to the per-user Zhipu key", () => {
    assert.equal(getModelProvider("glm-5.2"), "zhipu");
    assert.equal(getModelProvider("glm-4.7-flashx"), "zhipu");
    assert.equal(modelGroupToProvider("Zhipu"), "zhipu");
    assert.equal(providerLabel("zhipu"), "Zhipu GLM");
});

test("does not claim a GLM model is available without the current user's key", () => {
    assert.equal(
        isModelAvailable("glm-5.2", {
            zhipu: { configured: false, source: null },
        }),
        false,
    );
    assert.equal(
        isModelAvailable("glm-5.2", {
            zhipu: { configured: true, source: "user" },
        }),
        true,
    );
});
