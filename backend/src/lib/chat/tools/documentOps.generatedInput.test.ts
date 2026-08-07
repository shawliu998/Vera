import assert from "node:assert/strict";
import test from "node:test";

import {
  isValidGenerateDocxInput,
  isValidGenerateExcelInput,
} from "./documentOps";

test("generated Word input is mechanically validated before effect reservation", () => {
  assert.equal(
    isValidGenerateDocxInput({ title: "Opinion", sections: [] }),
    true,
  );
  assert.equal(isValidGenerateDocxInput({ title: " ", sections: [] }), false);
  assert.equal(isValidGenerateDocxInput({ title: "Opinion" }), false);
});

test("generated Excel input can be corrected before effect reservation", () => {
  assert.equal(
    isValidGenerateExcelInput({
      title: "Evidence inventory",
      sheets: [{ name: "Inventory", columns: ["Source"], rows: [] }],
    }),
    true,
  );
  assert.equal(
    isValidGenerateExcelInput({
      title: "Evidence inventory",
      sheets: [{ name: "Inventory", columns: [], rows: [] }],
    }),
    false,
  );
  assert.equal(
    isValidGenerateExcelInput({ title: "Evidence inventory", sheets: [] }),
    false,
  );
});
