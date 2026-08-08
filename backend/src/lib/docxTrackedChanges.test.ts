import assert from "node:assert/strict";
import test from "node:test";

import { Document, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";

import {
  applyDocxComments,
  applyTrackedEdits,
  docxReviewMarkupOutsideMainStory,
  extractDocxBodyText,
  extractDocxReviewMarkup,
  finalizeCleanDocx,
} from "./docxTrackedChanges";

async function simpleDocx(text: string) {
  return Buffer.from(
    await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [new Paragraph({ children: [new TextRun(text)] })],
          },
        ],
      }),
    ),
  );
}

async function addClassicComment(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const document = await zip.file("word/document.xml")!.async("string");
  const withMarkers = document.replace(
    /(<w:r\b[^>]*>[\s\S]*?<\/w:r>)/,
    '<w:commentRangeStart w:id="0"/>$1<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>',
  );
  zip.file("word/document.xml", withMarkers);
  zip.file(
    "word/comments.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Vera"><w:p><w:r><w:t>Keep the operative text.</w:t></w:r></w:p></w:comment></w:comments>',
  );
  const relsPath = "word/_rels/document.xml.rels";
  const rels = await zip.file(relsPath)!.async("string");
  zip.file(
    relsPath,
    rels.replace(
      "</Relationships>",
      '<Relationship Id="rIdVeraComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>',
    ),
  );
  const contentTypesPath = "[Content_Types].xml";
  const contentTypes = await zip.file(contentTypesPath)!.async("string");
  zip.file(
    contentTypesPath,
    contentTypes.replace(
      "</Types>",
      '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>',
    ),
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

test("finalizeCleanDocx accepts revisions and removes classic comments", async () => {
  const source = await simpleDocx("This Agreement is governed by English law.");
  const revision = await applyTrackedEdits(
    source,
    [
      {
        find: "English law",
        replace: "PRC law",
        context_before: "governed by",
        context_after: ".",
        reason: "PRC-NDA-001",
      },
    ],
    { author: "Vera" },
  );
  assert.equal(revision.errors.length, 0);
  assert.equal(revision.changes.length, 1);

  const commented = await addClassicComment(revision.bytes);
  const clean = await finalizeCleanDocx(commented);
  assert.equal(
    await extractDocxBodyText(clean),
    "This Agreement is governed by PRC law.",
  );
  assert.deepEqual((await extractDocxReviewMarkup(clean)).items, []);

  const zip = await JSZip.loadAsync(clean);
  assert.equal(zip.file("word/comments.xml"), null);
  assert.doesNotMatch(
    await zip.file("word/document.xml")!.async("string"),
    /commentRange|commentReference/,
  );
  assert.doesNotMatch(
    await zip.file("word/_rels/document.xml.rels")!.async("string"),
    /\/comments"/,
  );
  assert.doesNotMatch(
    await zip.file("[Content_Types].xml")!.async("string"),
    /\/word\/comments\.xml/,
  );
});

test("clean finalization fails closed for hidden-story review markup", async () => {
  const source = await simpleDocx("Main story");
  const zip = await JSZip.loadAsync(source);
  zip.file(
    "word/header1.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:ins w:id="7"><w:r><w:t>Hidden edit</w:t></w:r></w:ins></w:p></w:hdr>',
  );
  const withHeader = Buffer.from(
    await zip.generateAsync({ type: "nodebuffer" }),
  );
  assert.deepEqual(await docxReviewMarkupOutsideMainStory(withHeader), [
    "word/header1.xml",
  ]);
  await assert.rejects(
    () => finalizeCleanDocx(withHeader),
    /outside the main story/i,
  );
});

test("applyDocxComments writes one native comment on a unique exact span", async () => {
  const source = Buffer.from(
    await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph({
                children: [
                  new TextRun("The confidentiality "),
                  new TextRun({ text: "obligations", bold: true }),
                  new TextRun(" continue for one year."),
                ],
              }),
            ],
          },
        ],
      }),
    ),
  );
  const result = await applyDocxComments(
    source,
    [
      {
        anchor: "confidentiality obligations continue",
        comment: "Confirm the survival period with the business owner.",
        reason: "PRC-NDA-002",
      },
    ],
    {
      author: "Vera",
      initials: "V",
      date: "2026-08-08T00:00:00.000Z",
    },
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.comments.length, 1);
  assert.equal(
    await extractDocxBodyText(result.bytes),
    "The confidentiality obligations continue for one year.",
  );
  const markup = await extractDocxReviewMarkup(result.bytes);
  assert.deepEqual(
    markup.items.map((item) => ({
      kind: item.kind,
      text: item.kind === "comment" ? item.text : item.text,
      anchor: item.kind === "comment" ? item.anchorText : null,
    })),
    [
      {
        kind: "comment",
        text: "Confirm the survival period with the business owner.",
        anchor: "confidentiality obligations continue",
      },
    ],
  );
  const zip = await JSZip.loadAsync(result.bytes);
  assert.ok(zip.file("word/comments.xml"));
  assert.match(
    await zip.file("word/_rels/document.xml.rels")!.async("string"),
    /relationships\/comments/,
  );
  assert.match(
    await zip.file("[Content_Types].xml")!.async("string"),
    /word\/comments\.xml/,
  );
});

test("applyDocxComments refuses ambiguous and pending-insertion anchors", async () => {
  const ambiguous = await simpleDocx("repeat repeat");
  const ambiguousResult = await applyDocxComments(ambiguous, [
    { anchor: "repeat", comment: "Which occurrence?" },
  ]);
  assert.equal(ambiguousResult.comments.length, 0);
  assert.match(ambiguousResult.errors[0]?.reason ?? "", /ambiguous/i);
  assert.equal(ambiguousResult.bytes, ambiguous);

  const source = await simpleDocx("The term is one year.");
  const revision = await applyTrackedEdits(source, [
    {
      find: "one year",
      replace: "two years",
      context_before: "term is",
      context_after: ".",
    },
  ]);
  const pending = await applyDocxComments(revision.bytes, [
    { anchor: "two years", comment: "Do not silently accept this edit." },
  ]);
  assert.equal(pending.comments.length, 0);
  assert.match(pending.errors[0]?.reason ?? "", /pending insertion/i);
});
