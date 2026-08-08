import assert from "node:assert/strict";
import test from "node:test";

import { documentSelectorExcludedProjectId } from "./documentSelectorScope";

test("Work Task source selection can include documents already owned by the current Matter", () => {
    assert.equal(
        documentSelectorExcludedProjectId("matter-1", true),
        undefined,
    );
    assert.equal(
        documentSelectorExcludedProjectId("matter-1", false),
        "matter-1",
    );
});
