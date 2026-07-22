import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import {
    extractAcceptedDocxText,
    extractAcceptedDocxTextFromDocumentXml,
} from "./docxAcceptedView";

const ACCEPTED_VIEW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t>Base </w:t></w:r>
      <w:ins><w:r><w:t>accepted insertion</w:t></w:r></w:ins>
      <w:del><w:r><w:delText> rejected deletion</w:delText></w:r></w:del>
    </w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table clause</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:sdt><w:sdtContent><w:p><w:r><w:t>Controlled clause</w:t></w:r></w:p></w:sdtContent></w:sdt>
  </w:body>
</w:document>`;

const EXPECTED_ACCEPTED_VIEW =
    "Base accepted insertion\nTable clause\nControlled clause";

test("extracts a DOCX accepted view with insertions, deletions, tables, and content controls", () => {
    assert.equal(
        extractAcceptedDocxTextFromDocumentXml(ACCEPTED_VIEW_XML),
        EXPECTED_ACCEPTED_VIEW,
    );
});

test("reads the accepted view from a DOCX package", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", ACCEPTED_VIEW_XML);
    const bytes = await zip.generateAsync({ type: "arraybuffer" });

    assert.equal(await extractAcceptedDocxText(bytes), EXPECTED_ACCEPTED_VIEW);
});
