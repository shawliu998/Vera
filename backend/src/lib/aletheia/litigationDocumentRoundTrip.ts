import { createHash } from "node:crypto";
import {
  Bookmark,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { XMLParser } from "fast-xml-parser";
import PizZip from "pizzip";
import type { LitigationDocumentDraftSection } from "./litigationDomain";

export const DOCUMENT_DRAFT_ROUND_TRIP_PROTOCOL =
  "vera-litigation-document-round-trip-v1";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 40 * 1024 * 1024;
const MAX_SECTION_BODY = 50_000;
const MAX_TOTAL_BODY = 200_000;
const PROPERTY_PREFIX = "Vera";

export type DocumentDraftRoundTripBinding = {
  matterId: string;
  documentId: string;
  baseVersionId: string;
  baseVersion: number;
  baseContentHash: string;
  sourceContentHash: string;
  sourceDependencyHash: string;
};

export class DocumentDraftRoundTripError extends Error {
  constructor(
    message: string,
    readonly code:
      | "DOCX_INVALID"
      | "DOCX_TOO_LARGE"
      | "DOCX_UNSAFE_PATH"
      | "DOCX_ACTIVE_CONTENT"
      | "DOCX_EXTERNAL_RELATIONSHIP"
      | "DOCX_TRACKED_CHANGES"
      | "DOCX_BINDING_MISSING"
      | "DOCX_BINDING_MISMATCH"
      | "DOCX_SECTION_INVALID"
      | "DOCX_SOURCE_CHANGED"
      | "DOCX_NO_CHANGES",
    readonly status = 400,
  ) {
    super(message);
    this.name = "DocumentDraftRoundTripError";
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function sha256(value: Buffer | string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sectionManifest(sections: LitigationDocumentDraftSection[]) {
  return sections.map((section) => ({
    id: section.id,
    bookmark: `vera_section_${section.id}`,
  }));
}

function sectionManifestHash(sections: LitigationDocumentDraftSection[]) {
  return sha256(stableJson(sectionManifest(sections)));
}

function bindingPayload(
  binding: DocumentDraftRoundTripBinding,
  sections: LitigationDocumentDraftSection[],
) {
  return {
    protocol: DOCUMENT_DRAFT_ROUND_TRIP_PROTOCOL,
    ...binding,
    sectionManifest: sectionManifest(sections),
    sectionManifestHash: sectionManifestHash(sections),
  };
}

function bindingHash(
  binding: DocumentDraftRoundTripBinding,
  sections: LitigationDocumentDraftSection[],
) {
  return sha256(stableJson(bindingPayload(binding, sections)));
}

function bodyParagraphs(body: string) {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  return lines.map(
    (line) =>
      new Paragraph({
        children: [new TextRun(line)],
        spacing: { after: 80 },
      }),
  );
}

export async function buildBoundDocumentDraftDocx(args: {
  title: string;
  binding: DocumentDraftRoundTripBinding;
  sections: LitigationDocumentDraftSection[];
  exportedAt: string;
}) {
  const payload = bindingPayload(args.binding, args.sections);
  const properties = [
    ["Protocol", payload.protocol],
    ["MatterId", payload.matterId],
    ["DocumentId", payload.documentId],
    ["BaseVersionId", payload.baseVersionId],
    ["BaseVersion", String(payload.baseVersion)],
    ["BaseContentHash", payload.baseContentHash],
    ["SourceContentHash", payload.sourceContentHash],
    ["SourceDependencyHash", payload.sourceDependencyHash],
    ["SectionManifest", stableJson(payload.sectionManifest)],
    ["SectionManifestHash", payload.sectionManifestHash],
    ["BindingHash", bindingHash(args.binding, args.sections)],
  ] as const;
  const children: Paragraph[] = [
    new Paragraph({ text: args.title.trim() || "Litigation working draft", heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Vera working draft · base version ${args.binding.baseVersion}`,
          bold: true,
        }),
      ],
      spacing: { after: 80 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Base content hash: ", bold: true, size: 18 }),
        new TextRun({ text: args.binding.baseContentHash, font: "Courier New", size: 18 }),
      ],
      spacing: { after: 240 },
    }),
  ];
  for (const section of args.sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [
          new Bookmark({
            id: `vera_section_${section.id}`,
            children: [new TextRun({ text: section.heading, bold: true })],
          }),
        ],
      }),
      ...bodyParagraphs(section.body),
    );
  }
  const document = new Document({
    creator: "Vera",
    title: args.title,
    description: `Bound Vera litigation draft ${args.binding.documentId}`,
    customProperties: properties.map(([name, value]) => ({
      name: `${PROPERTY_PREFIX}${name}`,
      value,
    })),
    styles: {
      default: {
        document: { run: { font: "Arial", size: 22 } },
        title: { run: { font: "Arial", size: 34, bold: true } },
        heading1: { run: { font: "Arial", size: 26, bold: true } },
      },
    },
    sections: [
      {
        headers: {
          default: new Header({
            children: [new Paragraph({ text: "Vera · Litigation working draft" })],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                text: `Exported ${args.exportedAt} · ${args.binding.baseContentHash}`,
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  const bytes = await Packer.toBuffer(document);
  return {
    bytes,
    fileSha256: sha256(bytes),
    bindingHash: bindingHash(args.binding, args.sections),
    sectionManifestHash: sectionManifestHash(args.sections),
  };
}

type OrderedNode = Record<string, unknown>;

const orderedParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  processEntities: false,
});
const objectParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  processEntities: false,
});

function parseXml(xml: string, label: string, ordered = false) {
  try {
    return (ordered ? orderedParser : objectParser).parse(xml);
  } catch {
    throw new DocumentDraftRoundTripError(
      `${label} is not valid XML.`,
      "DOCX_INVALID",
    );
  }
}

function safeZip(buffer: Buffer) {
  if (buffer.length < 1 || buffer.length > MAX_FILE_BYTES) {
    throw new DocumentDraftRoundTripError(
      "DOCX must be between 1 byte and 10 MB.",
      "DOCX_TOO_LARGE",
    );
  }
  let archive: PizZip;
  try {
    archive = new PizZip(buffer);
  } catch {
    throw new DocumentDraftRoundTripError(
      "The uploaded file is not a valid DOCX package.",
      "DOCX_INVALID",
    );
  }
  const names = Object.keys(archive.files);
  if (
    !names.includes("[Content_Types].xml") ||
    !names.includes("word/document.xml") ||
    !names.includes("docProps/custom.xml")
  ) {
    throw new DocumentDraftRoundTripError(
      "The DOCX is missing required Vera binding parts.",
      "DOCX_BINDING_MISSING",
    );
  }
  let expanded = 0;
  for (const name of names) {
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((part) => part === ".." || part === ".")
    ) {
      throw new DocumentDraftRoundTripError(
        "The DOCX contains an unsafe package path.",
        "DOCX_UNSAFE_PATH",
      );
    }
    const file = archive.file(name);
    if (!file) continue;
    expanded += file.asUint8Array().byteLength;
    if (expanded > MAX_EXPANDED_BYTES) {
      throw new DocumentDraftRoundTripError(
        "The DOCX expands beyond the 40 MB safety limit.",
        "DOCX_TOO_LARGE",
      );
    }
  }
  if (names.some((name) => /(^|\/)(EncryptionInfo|EncryptedPackage)$/i.test(name))) {
    throw new DocumentDraftRoundTripError(
      "Encrypted DOCX packages cannot be inspected safely.",
      "DOCX_ACTIVE_CONTENT",
    );
  }
  if (
    names.some(
      (name) =>
        /(^|\/)vbaProject\.bin$/i.test(name) ||
        name.startsWith("word/activeX/") ||
        name.startsWith("word/embeddings/") ||
        name.startsWith("word/oleObject") ||
        name.startsWith("customXml/"),
    )
  ) {
    throw new DocumentDraftRoundTripError(
      "Macros, ActiveX, embedded objects, OLE, and custom XML are not allowed.",
      "DOCX_ACTIVE_CONTENT",
    );
  }
  return archive;
}

function walkObject(value: unknown, visit: (key: string, value: unknown) => void) {
  if (Array.isArray(value)) {
    for (const item of value) walkObject(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    visit(key, item);
    walkObject(item, visit);
  }
}

function inspectRelationships(archive: PizZip) {
  for (const name of Object.keys(archive.files).filter((item) => item.endsWith(".rels"))) {
    const file = archive.file(name);
    if (!file) continue;
    const parsed = parseXml(file.asText(), name);
    walkObject(parsed, (key, value) => {
      if (key !== "Relationship") return;
      const rows = Array.isArray(value) ? value : [value];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const relation = row as Record<string, unknown>;
        if (String(relation["@_TargetMode"] ?? "").toLowerCase() === "external") {
          throw new DocumentDraftRoundTripError(
            "External DOCX relationships are not allowed.",
            "DOCX_EXTERNAL_RELATIONSHIP",
          );
        }
        const relationshipType = String(relation["@_Type"] ?? "")
          .split("/")
          .at(-1);
        if (["attachedTemplate", "oleObject", "package"].includes(relationshipType ?? "")) {
          throw new DocumentDraftRoundTripError(
            "Attached templates and embedded packages are not allowed.",
            "DOCX_ACTIVE_CONTENT",
          );
        }
      }
    });
  }
}

function customProperties(archive: PizZip) {
  const xml = archive.file("docProps/custom.xml")?.asText() ?? "";
  const parsed = parseXml(xml, "DOCX custom properties") as Record<string, unknown>;
  const properties: Record<string, string> = {};
  walkObject(parsed, (key, value) => {
    if (key !== "property") return;
    const rows = Array.isArray(value) ? value : [value];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const property = row as Record<string, unknown>;
      const name = String(property["@_name"] ?? "");
      const raw = property["vt:lpwstr"] ?? property["vt:i4"];
      if (!name || raw === undefined) continue;
      if (name in properties) {
        throw new DocumentDraftRoundTripError(
          "The DOCX contains duplicate Vera custom properties.",
          "DOCX_BINDING_MISMATCH",
        );
      }
      const propertyValue =
        raw && typeof raw === "object" && "#text" in (raw as Record<string, unknown>)
          ? (raw as Record<string, unknown>)["#text"]
          : raw;
      properties[name] = String(propertyValue ?? "")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
    }
  });
  return properties;
}

function orderedChildren(node: unknown): OrderedNode[] {
  return Array.isArray(node) ? (node.filter(Boolean) as OrderedNode[]) : [];
}

function tagChildren(node: OrderedNode, tag: string) {
  return orderedChildren(node[tag]);
}

function recursiveTagNames(value: unknown, output = new Set<string>()) {
  for (const node of orderedChildren(value)) {
    for (const [key, child] of Object.entries(node)) {
      if (key === ":@") continue;
      output.add(key);
      recursiveTagNames(child, output);
    }
  }
  return output;
}

function paragraphText(nodes: OrderedNode[]): string {
  let result = "";
  const visit = (items: OrderedNode[]) => {
    for (const node of items) {
      for (const [key, child] of Object.entries(node)) {
        if (key === ":@") continue;
        if (key === "w:t" || key === "#text") {
          const children = orderedChildren(child);
          if (children.length) visit(children);
          else if (typeof child === "string") result += child;
          continue;
        }
        if (key === "w:tab") result += "\t";
        else if (key === "w:br" || key === "w:cr") result += "\n";
        else visit(orderedChildren(child));
      }
    }
  };
  visit(nodes);
  return result;
}

function paragraphBookmark(nodes: OrderedNode[]) {
  const found: string[] = [];
  const visit = (items: OrderedNode[]) => {
    for (const node of items) {
      for (const [key, child] of Object.entries(node)) {
        if (key === "w:bookmarkStart") {
          const attrs = node[":@"] as Record<string, unknown> | undefined;
          const name = String(attrs?.["@_w:name"] ?? "");
          if (name.startsWith("vera_section_")) found.push(name);
        }
        visit(orderedChildren(child));
      }
    }
  };
  visit(nodes);
  return found;
}

function documentParagraphs(archive: PizZip) {
  const xml = archive.file("word/document.xml")?.asText() ?? "";
  const parsed = parseXml(xml, "DOCX document", true) as OrderedNode[];
  const tags = recursiveTagNames(parsed);
  if (["w:ins", "w:del", "w:moveFrom", "w:moveTo"].some((tag) => tags.has(tag))) {
    throw new DocumentDraftRoundTripError(
      "Accept or reject all tracked changes in Word before importing this DOCX.",
      "DOCX_TRACKED_CHANGES",
    );
  }
  if (
    [
      "w:altChunk",
      "w:object",
      "w:oleObject",
      "w:fldSimple",
      "w:instrText",
      "w:drawing",
      "w:pict",
      "w:txbxContent",
    ].some((tag) => tags.has(tag))
  ) {
    throw new DocumentDraftRoundTripError(
      "Alternate content and embedded objects are not allowed.",
      "DOCX_ACTIVE_CONTENT",
    );
  }
  const paragraphs: Array<{ text: string; bookmarks: string[] }> = [];
  const visit = (items: OrderedNode[]) => {
    for (const node of items) {
      if ("w:p" in node) {
        const children = tagChildren(node, "w:p");
        paragraphs.push({
          text: paragraphText(children).replace(/\r\n?/g, "\n"),
          bookmarks: paragraphBookmark(children),
        });
        continue;
      }
      for (const [key, child] of Object.entries(node)) {
        if (key !== ":@") visit(orderedChildren(child));
      }
    }
  };
  visit(parsed);
  return paragraphs;
}

function normalizeSections(sections: LitigationDocumentDraftSection[]) {
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > 20) {
    throw new DocumentDraftRoundTripError(
      "The DOCX must contain between 1 and 20 bound sections.",
      "DOCX_SECTION_INVALID",
    );
  }
  const seen = new Set<string>();
  let total = 0;
  return sections.map((section) => {
    const id = String(section.id ?? "").trim();
    const heading = String(section.heading ?? "").trim();
    const body = String(section.body ?? "").replace(/\r\n?/g, "\n").trim();
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(id) || seen.has(id) || !heading || heading.length > 240) {
      throw new DocumentDraftRoundTripError(
        "A DOCX section id or heading is invalid.",
        "DOCX_SECTION_INVALID",
      );
    }
    if (body.length > MAX_SECTION_BODY) {
      throw new DocumentDraftRoundTripError(
        "A DOCX section exceeds the 50,000 character limit.",
        "DOCX_SECTION_INVALID",
      );
    }
    seen.add(id);
    total += body.length;
    if (total > MAX_TOTAL_BODY) {
      throw new DocumentDraftRoundTripError(
        "The DOCX body exceeds the 200,000 character limit.",
        "DOCX_SECTION_INVALID",
      );
    }
    return { id, heading, body };
  });
}

function requiredProperty(properties: Record<string, string>, name: string) {
  const value = properties[`${PROPERTY_PREFIX}${name}`];
  if (!value) {
    throw new DocumentDraftRoundTripError(
      `The Vera ${name} binding is missing.`,
      "DOCX_BINDING_MISSING",
    );
  }
  return value;
}

export function parseBoundDocumentDraftDocx(args: {
  bytes: Buffer;
  expected: DocumentDraftRoundTripBinding;
  currentSections: LitigationDocumentDraftSection[];
}) {
  const currentSections = normalizeSections(args.currentSections);
  const archive = safeZip(args.bytes);
  inspectRelationships(archive);
  const properties = customProperties(archive);
  const expectedPayload = bindingPayload(args.expected, currentSections);
  const actual = {
    protocol: requiredProperty(properties, "Protocol"),
    matterId: requiredProperty(properties, "MatterId"),
    documentId: requiredProperty(properties, "DocumentId"),
    baseVersionId: requiredProperty(properties, "BaseVersionId"),
    baseVersion: Number(requiredProperty(properties, "BaseVersion")),
    baseContentHash: requiredProperty(properties, "BaseContentHash"),
    sourceContentHash: requiredProperty(properties, "SourceContentHash"),
    sourceDependencyHash: requiredProperty(properties, "SourceDependencyHash"),
    sectionManifest: requiredProperty(properties, "SectionManifest"),
    sectionManifestHash: requiredProperty(properties, "SectionManifestHash"),
    bindingHash: requiredProperty(properties, "BindingHash"),
  };
  let manifest: unknown;
  try {
    manifest = JSON.parse(actual.sectionManifest);
  } catch {
    throw new DocumentDraftRoundTripError(
      "The Vera section manifest is invalid.",
      "DOCX_BINDING_MISMATCH",
    );
  }
  const expectedManifest = sectionManifest(currentSections);
  const expectedBindingHash = bindingHash(args.expected, currentSections);
  if (
    actual.protocol !== expectedPayload.protocol ||
    actual.matterId !== expectedPayload.matterId ||
    actual.documentId !== expectedPayload.documentId ||
    actual.baseVersionId !== expectedPayload.baseVersionId ||
    actual.baseVersion !== expectedPayload.baseVersion ||
    actual.baseContentHash !== expectedPayload.baseContentHash ||
    actual.sourceContentHash !== expectedPayload.sourceContentHash ||
    actual.sourceDependencyHash !== expectedPayload.sourceDependencyHash ||
    stableJson(manifest) !== stableJson(expectedManifest) ||
    actual.sectionManifestHash !== expectedPayload.sectionManifestHash ||
    actual.bindingHash !== expectedBindingHash
  ) {
    throw new DocumentDraftRoundTripError(
      "The DOCX binding does not match the current matter and draft version.",
      "DOCX_BINDING_MISMATCH",
      409,
    );
  }
  const paragraphs = documentParagraphs(archive);
  const sections: LitigationDocumentDraftSection[] = [];
  let current: LitigationDocumentDraftSection | null = null;
  for (const paragraph of paragraphs) {
    if (paragraph.bookmarks.length > 1) {
      throw new DocumentDraftRoundTripError(
        "A DOCX paragraph contains duplicate Vera section bindings.",
        "DOCX_SECTION_INVALID",
      );
    }
    if (paragraph.bookmarks.length === 1) {
      const bookmark = paragraph.bookmarks[0];
      const expectedEntry = expectedManifest[sections.length];
      if (!expectedEntry || bookmark !== expectedEntry.bookmark) {
        throw new DocumentDraftRoundTripError(
          "DOCX sections are missing, duplicated, unknown, or reordered.",
          "DOCX_SECTION_INVALID",
        );
      }
      current = { id: expectedEntry.id, heading: paragraph.text.trim(), body: "" };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    current.body += `${current.body ? "\n" : ""}${paragraph.text}`;
  }
  const normalized = normalizeSections(sections);
  if (stableJson(sectionManifest(normalized)) !== stableJson(expectedManifest)) {
    throw new DocumentDraftRoundTripError(
      "DOCX sections are incomplete.",
      "DOCX_SECTION_INVALID",
    );
  }
  const currentSource = currentSections.find((section) => section.id === "sources");
  const importedSource = normalized.find((section) => section.id === "sources");
  if (
    !currentSource ||
    !importedSource ||
    sha256(stableJson(currentSource)) !== sha256(stableJson(importedSource))
  ) {
    throw new DocumentDraftRoundTripError(
      "The read-only sources section changed in the DOCX.",
      "DOCX_SOURCE_CHANGED",
      409,
    );
  }
  if (sha256(stableJson(currentSections)) === sha256(stableJson(normalized))) {
    throw new DocumentDraftRoundTripError(
      "The imported DOCX contains no document changes.",
      "DOCX_NO_CHANGES",
      409,
    );
  }
  return {
    protocol: DOCUMENT_DRAFT_ROUND_TRIP_PROTOCOL,
    sections: normalized,
    fileSha256: sha256(args.bytes),
    bindingHash: expectedBindingHash,
    sectionManifestHash: expectedPayload.sectionManifestHash,
  };
}
