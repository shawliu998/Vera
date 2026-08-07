import { XMLParser, XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";

import { sameUuidIdentity } from "./uuidIdentity";

const CONTENT_TYPES_PATH = "[Content_Types].xml";
const CUSTOM_PROPERTIES_PATH = "docProps/custom.xml";
const ROOT_RELATIONSHIPS_PATH = "_rels/.rels";
const CUSTOM_PROPERTIES_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.custom-properties+xml";
const CUSTOM_PROPERTIES_RELATIONSHIP_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties";
const CUSTOM_PROPERTIES_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties";
const CUSTOM_PROPERTY_FORMAT_ID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";
const CHUNK_LENGTH = 200;
const MAX_CHUNKS = 20;

export const TASK_WORD_ARTIFACT_COUNT_PROPERTY =
  "VeraTaskArtifactBindingCount";
export const TASK_WORD_ARTIFACT_PROPERTY_PREFIX = "VeraTaskArtifactBinding";
export const TASK_WORD_ARTIFACT_KIND = "agent-task-word-artifact-v1";

export type TaskWordArtifactReceiptV1 = {
  schemaVersion: 1;
  kind: typeof TASK_WORD_ARTIFACT_KIND;
  taskId: string;
  projectId: string;
  deliverableKey: string;
  documentId: string;
  versionId: string;
};

export class TaskWordArtifactReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskWordArtifactReceiptError";
  }
}

function parseXml(xml: string, label: string) {
  if (XMLValidator.validate(xml) !== true) {
    throw new TaskWordArtifactReceiptError(
      `The DOCX ${label} XML is malformed`,
    );
  }
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
  }).parse(xml) as Record<string, unknown>;
}

function xmlText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function requiredString(value: unknown, field: string) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new TaskWordArtifactReceiptError(
      `The Task Word artifact ${field} is invalid`,
    );
  }
  return value;
}

function validateReceipt(value: unknown): TaskWordArtifactReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskWordArtifactReceiptError(
      "The Task Word artifact receipt is invalid",
    );
  }
  const receipt = value as Record<string, unknown>;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== TASK_WORD_ARTIFACT_KIND
  ) {
    throw new TaskWordArtifactReceiptError(
      "The Task Word artifact receipt schema is invalid",
    );
  }
  return {
    schemaVersion: 1,
    kind: TASK_WORD_ARTIFACT_KIND,
    taskId: requiredString(receipt.taskId, "taskId"),
    projectId: requiredString(receipt.projectId, "projectId"),
    deliverableKey: requiredString(receipt.deliverableKey, "deliverableKey"),
    documentId: requiredString(receipt.documentId, "documentId"),
    versionId: requiredString(receipt.versionId, "versionId"),
  };
}

export function sameTaskWordArtifactReceipt(
  left: TaskWordArtifactReceiptV1,
  right: TaskWordArtifactReceiptV1,
) {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    sameUuidIdentity(left.taskId, right.taskId) &&
    sameUuidIdentity(left.projectId, right.projectId) &&
    left.deliverableKey === right.deliverableKey &&
    sameUuidIdentity(left.documentId, right.documentId) &&
    sameUuidIdentity(left.versionId, right.versionId)
  );
}

function parseCustomProperty(xml: string) {
  const parsed = parseXml(
    `<Properties xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${xml}</Properties>`,
    "custom property",
  );
  const properties = parsed.Properties;
  const item =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? (properties as Record<string, unknown>).property
      : null;
  if (!item || Array.isArray(item) || typeof item !== "object") {
    throw new TaskWordArtifactReceiptError(
      "The Task Word artifact custom property is malformed",
    );
  }
  const record = item as Record<string, unknown>;
  if (
    typeof record["@_name"] !== "string" ||
    !record["@_name"] ||
    typeof record["vt:lpwstr"] !== "string"
  ) {
    throw new TaskWordArtifactReceiptError(
      "The Task Word artifact custom property is malformed",
    );
  }
  return { name: record["@_name"], value: record["vt:lpwstr"] };
}

function customProperties(customXml: string) {
  return Array.from(
    customXml.matchAll(/<property\b[\s\S]*?<\/property>/g),
    (match) => parseCustomProperty(match[0]),
  );
}

function propertyName(index: number) {
  return `${TASK_WORD_ARTIFACT_PROPERTY_PREFIX}${String(index).padStart(3, "0")}`;
}

function encodeReceipt(receipt: TaskWordArtifactReceiptV1) {
  const characters = Array.from(
    JSON.stringify(receipt).replace(
      /\s/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
  );
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += CHUNK_LENGTH) {
    chunks.push(characters.slice(offset, offset + CHUNK_LENGTH).join(""));
  }
  if (!chunks.length || chunks.length > MAX_CHUNKS) {
    throw new TaskWordArtifactReceiptError(
      "The Task Word artifact receipt is too large",
    );
  }
  return chunks;
}

function decodeProperties(properties: Array<{ name: string; value: string }>) {
  const bindings = properties.filter((property) =>
    property.name.startsWith(TASK_WORD_ARTIFACT_PROPERTY_PREFIX),
  );
  if (!bindings.length) return null;
  const values = new Map<string, string>();
  for (const property of bindings) {
    if (values.has(property.name)) {
      throw new TaskWordArtifactReceiptError(
        "The Task Word artifact custom properties are malformed",
      );
    }
    values.set(property.name, property.value);
  }
  const count = Number(values.get(TASK_WORD_ARTIFACT_COUNT_PROPERTY));
  if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) {
    throw new TaskWordArtifactReceiptError(
      "The Task Word artifact custom properties are malformed",
    );
  }
  let json = "";
  for (let index = 1; index <= count; index += 1) {
    const chunk = values.get(propertyName(index));
    if (typeof chunk !== "string") {
      throw new TaskWordArtifactReceiptError(
        "The Task Word artifact custom properties are malformed",
      );
    }
    json += chunk;
  }
  try {
    return validateReceipt(JSON.parse(json));
  } catch (error) {
    if (error instanceof TaskWordArtifactReceiptError) throw error;
    throw new TaskWordArtifactReceiptError(
      "The Task Word artifact custom property is invalid",
    );
  }
}

function removeReceiptProperties(customXml: string) {
  return customXml.replace(/<property\b[\s\S]*?<\/property>/g, (property) =>
    parseCustomProperty(property).name.startsWith(
      TASK_WORD_ARTIFACT_PROPERTY_PREFIX,
    )
      ? ""
      : property,
  );
}

function propertyIds(customXml: string) {
  return Array.from(customXml.matchAll(/\bpid=(["'])(\d+)\1/g), (match) =>
    Number(match[2]),
  ).filter(Number.isSafeInteger);
}

function addCustomProperty(
  customXml: string,
  input: { name: string; value: string; pid: number },
) {
  const property = `<property fmtid="${CUSTOM_PROPERTY_FORMAT_ID}" pid="${input.pid}" name="${input.name}"><vt:lpwstr>${xmlText(input.value)}</vt:lpwstr></property>`;
  const selfClosing = /<Properties\b([^>]*)\/>\s*$/;
  if (selfClosing.test(customXml)) {
    return customXml.replace(
      selfClosing,
      `<Properties$1>${property}</Properties>`,
    );
  }
  const closing = /<\/Properties>\s*$/;
  if (!closing.test(customXml)) {
    throw new TaskWordArtifactReceiptError(
      "The DOCX custom properties package is malformed",
    );
  }
  return customXml.replace(closing, `${property}</Properties>`);
}

function ensureCustomProperties(
  existing: string | null,
  receipt: TaskWordArtifactReceiptV1,
) {
  const chunks = encodeReceipt(receipt);
  const values = [
    { name: TASK_WORD_ARTIFACT_COUNT_PROPERTY, value: String(chunks.length) },
    ...chunks.map((value, index) => ({
      name: propertyName(index + 1),
      value,
    })),
  ];
  const empty = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="${CUSTOM_PROPERTIES_NAMESPACE}" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>`;
  if (!existing) {
    return values.reduce(
      (xml, property, index) =>
        addCustomProperty(xml, { ...property, pid: index + 2 }),
      empty,
    );
  }
  const parsed = parseXml(existing, "custom properties");
  if (!parsed.Properties || typeof parsed.Properties !== "object") {
    throw new TaskWordArtifactReceiptError(
      "The DOCX custom properties root is invalid",
    );
  }
  const current = decodeProperties(customProperties(existing));
  if (current && !sameTaskWordArtifactReceipt(current, receipt)) {
    throw new TaskWordArtifactReceiptError(
      "The DOCX contains a conflicting Task Word artifact receipt",
    );
  }
  const withoutReceipt = current ? removeReceiptProperties(existing) : existing;
  let nextPid = Math.max(1, ...propertyIds(withoutReceipt)) + 1;
  return values.reduce((xml, property) => {
    const output = addCustomProperty(xml, { ...property, pid: nextPid });
    nextPid += 1;
    return output;
  }, withoutReceipt);
}

function ensureContentTypes(existing: string) {
  const parsed = parseXml(existing, "content types");
  if (!parsed.Types || typeof parsed.Types !== "object") {
    throw new TaskWordArtifactReceiptError(
      "The DOCX content types root is invalid",
    );
  }
  const pattern =
    /<Override\b(?=[^>]*\bPartName=(["'])\/docProps\/custom\.xml\1)[^>]*\/>/i;
  const current = existing.match(pattern)?.[0];
  if (current) {
    const contentType = current.match(/\bContentType=(["'])(.*?)\1/i)?.[2];
    if (contentType !== CUSTOM_PROPERTIES_CONTENT_TYPE) {
      throw new TaskWordArtifactReceiptError(
        "The DOCX custom properties content type conflicts with the required OOXML part",
      );
    }
    return existing;
  }
  if (!/<\/Types>\s*$/.test(existing)) {
    throw new TaskWordArtifactReceiptError(
      "The DOCX content types package is malformed",
    );
  }
  return existing.replace(
    /<\/Types>\s*$/,
    `<Override PartName="/docProps/custom.xml" ContentType="${CUSTOM_PROPERTIES_CONTENT_TYPE}"/></Types>`,
  );
}

function ensureRootRelationships(existing: string | null) {
  if (!existing) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${CUSTOM_PROPERTIES_RELATIONSHIP_TYPE}" Target="docProps/custom.xml"/></Relationships>`;
  }
  const parsed = parseXml(existing, "root relationships");
  if (!parsed.Relationships || typeof parsed.Relationships !== "object") {
    throw new TaskWordArtifactReceiptError(
      "The DOCX root relationships root is invalid",
    );
  }
  const pattern =
    /<Relationship\b(?=[^>]*\bTarget=(["'])docProps\/custom\.xml\1)[^>]*\/>/i;
  const current = existing.match(pattern)?.[0];
  if (current) {
    const relationshipType = current.match(/\bType=(["'])(.*?)\1/i)?.[2];
    if (relationshipType !== CUSTOM_PROPERTIES_RELATIONSHIP_TYPE) {
      throw new TaskWordArtifactReceiptError(
        "The DOCX custom properties relationship conflicts with the required OOXML part",
      );
    }
    return existing;
  }
  const ids = Array.from(
    existing.matchAll(/\bId=(["'])rId(\d+)\1/gi),
    (match) => Number(match[2]),
  ).filter(Number.isSafeInteger);
  if (!/<\/Relationships>\s*$/.test(existing)) {
    throw new TaskWordArtifactReceiptError(
      "The DOCX root relationships package is malformed",
    );
  }
  return existing.replace(
    /<\/Relationships>\s*$/,
    `<Relationship Id="rId${Math.max(0, ...ids) + 1}" Type="${CUSTOM_PROPERTIES_RELATIONSHIP_TYPE}" Target="docProps/custom.xml"/></Relationships>`,
  );
}

async function loadDocx(buffer: Buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
    throw new TaskWordArtifactReceiptError(
      "A non-empty DOCX package is required",
    );
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new TaskWordArtifactReceiptError("A valid DOCX package is required");
  }
  if (!zip.file("word/document.xml") || !zip.file(CONTENT_TYPES_PATH)) {
    throw new TaskWordArtifactReceiptError("A valid DOCX package is required");
  }
  return zip;
}

async function readText(zip: JSZip, path: string) {
  return zip.file(path)?.async("string") ?? null;
}

export async function readTaskWordArtifactReceipt(buffer: Buffer) {
  const zip = await loadDocx(buffer);
  const custom = await readText(zip, CUSTOM_PROPERTIES_PATH);
  if (!custom) return null;
  parseXml(custom, "custom properties");
  return decodeProperties(customProperties(custom));
}

export async function bindTaskWordArtifactReceipt(
  buffer: Buffer,
  input: TaskWordArtifactReceiptV1,
) {
  const receipt = validateReceipt(input);
  const zip = await loadDocx(buffer);
  const [contentTypes, custom, rootRelationships] = await Promise.all([
    readText(zip, CONTENT_TYPES_PATH),
    readText(zip, CUSTOM_PROPERTIES_PATH),
    readText(zip, ROOT_RELATIONSHIPS_PATH),
  ]);
  if (!contentTypes) {
    throw new TaskWordArtifactReceiptError(
      "The DOCX content types part is missing",
    );
  }
  zip.file(CUSTOM_PROPERTIES_PATH, ensureCustomProperties(custom, receipt));
  zip.file(CONTENT_TYPES_PATH, ensureContentTypes(contentTypes));
  zip.file(ROOT_RELATIONSHIPS_PATH, ensureRootRelationships(rootRelationships));
  const output = await zip.generateAsync({ type: "nodebuffer" });
  const persisted = await readTaskWordArtifactReceipt(output);
  if (!persisted || !sameTaskWordArtifactReceipt(persisted, receipt)) {
    throw new TaskWordArtifactReceiptError(
      "The Task Word artifact receipt could not be written",
    );
  }
  return output;
}

export async function advanceTaskWordArtifactReceipt(
  buffer: Buffer,
  input: {
    predecessor: TaskWordArtifactReceiptV1;
    successor: TaskWordArtifactReceiptV1;
  },
) {
  const predecessor = validateReceipt(input.predecessor);
  const successor = validateReceipt(input.successor);
  if (
    !sameTaskWordArtifactReceipt(predecessor, {
      ...successor,
      versionId: predecessor.versionId,
    }) ||
    sameTaskWordArtifactReceipt(predecessor, successor)
  ) {
    throw new TaskWordArtifactReceiptError(
      "The Task Word artifact successor identity is invalid",
    );
  }
  const zip = await loadDocx(buffer);
  const [contentTypes, custom, rootRelationships] = await Promise.all([
    readText(zip, CONTENT_TYPES_PATH),
    readText(zip, CUSTOM_PROPERTIES_PATH),
    readText(zip, ROOT_RELATIONSHIPS_PATH),
  ]);
  if (!contentTypes) {
    throw new TaskWordArtifactReceiptError(
      "The DOCX content types part is missing",
    );
  }
  if (!custom) {
    throw new TaskWordArtifactReceiptError(
      "The Task Word artifact predecessor receipt is missing",
    );
  }
  parseXml(custom, "custom properties");
  const persistedPredecessor = decodeProperties(customProperties(custom));
  if (
    !persistedPredecessor ||
    !sameTaskWordArtifactReceipt(persistedPredecessor, predecessor)
  ) {
    throw new TaskWordArtifactReceiptError(
      "The Task Word artifact predecessor receipt does not match",
    );
  }
  zip.file(
    CUSTOM_PROPERTIES_PATH,
    ensureCustomProperties(removeReceiptProperties(custom), successor),
  );
  zip.file(CONTENT_TYPES_PATH, ensureContentTypes(contentTypes));
  zip.file(ROOT_RELATIONSHIPS_PATH, ensureRootRelationships(rootRelationships));
  const output = await zip.generateAsync({ type: "nodebuffer" });
  const persisted = await readTaskWordArtifactReceipt(output);
  if (!persisted || !sameTaskWordArtifactReceipt(persisted, successor)) {
    throw new TaskWordArtifactReceiptError(
      "The Task Word artifact successor receipt could not be written",
    );
  }
  return output;
}
