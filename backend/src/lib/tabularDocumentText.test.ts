import assert from "node:assert/strict";
import test from "node:test";

import { Document, Packer, Paragraph } from "docx";

import { extractTabularDocumentText } from "./tabularDocumentText";

test("extracts generated DOCX text for Tabular model context", async () => {
  const docx = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [new Paragraph("Termination requires thirty days notice.")],
        },
      ],
    }),
  );
  const buffer = docx.buffer.slice(
    docx.byteOffset,
    docx.byteOffset + docx.byteLength,
  ) as ArrayBuffer;
  assert.match(await extractTabularDocumentText(buffer, "DOCX"), /thirty days/);
});

test("unreadable document bytes fail safely without inventing text", async () => {
  const bytes = Buffer.from("not-an-office-document");
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  assert.equal(await extractTabularDocumentText(buffer, "docx"), "");
});
