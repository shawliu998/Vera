import { createHash } from "node:crypto";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

export const CUSTOM_LITIGATION_TEMPLATE_FIELDS = [
  "matter_title",
  "artifact_title",
  "organization_name",
  "court",
  "case_number",
  "generated_at",
  "content_hash",
  "aletheia_body",
] as const;

const ALLOWED_FIELDS = new Set<string>(CUSTOM_LITIGATION_TEMPLATE_FIELDS);
const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024;

export class LitigationDocxTemplateError extends Error {
  constructor(
    message: string,
    readonly code:
      | "TEMPLATE_TOO_LARGE"
      | "TEMPLATE_INVALID_DOCX"
      | "TEMPLATE_ACTIVE_CONTENT"
      | "TEMPLATE_EXTERNAL_RELATIONSHIP"
      | "TEMPLATE_FIELD_UNSUPPORTED"
      | "TEMPLATE_RENDER_FAILED",
  ) {
    super(message);
    this.name = "LitigationDocxTemplateError";
  }
}

function zip(buffer: Buffer) {
  try {
    return new PizZip(buffer);
  } catch {
    throw new LitigationDocxTemplateError(
      "The uploaded file is not a valid DOCX package.",
      "TEMPLATE_INVALID_DOCX",
    );
  }
}

function xmlText(value: string) {
  return value
    .replace(/<w:tab\/?\s*>/g, "\t")
    .replace(/<w:br\/?\s*>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function inspectLitigationDocxTemplate(buffer: Buffer) {
  if (buffer.length === 0 || buffer.length > MAX_TEMPLATE_BYTES) {
    throw new LitigationDocxTemplateError(
      "DOCX template must be between 1 byte and 10 MB.",
      "TEMPLATE_TOO_LARGE",
    );
  }
  const packageZip = zip(buffer);
  const names = Object.keys(packageZip.files);
  if (
    !names.includes("[Content_Types].xml") ||
    !names.includes("word/document.xml")
  ) {
    throw new LitigationDocxTemplateError(
      "DOCX template is missing required OOXML parts.",
      "TEMPLATE_INVALID_DOCX",
    );
  }
  if (
    names.some(
      (name) =>
        /(^|\/)vbaProject\.bin$/i.test(name) ||
        name.startsWith("word/embeddings/") ||
        name.startsWith("word/activeX/") ||
        name.startsWith("customXml/"),
    )
  ) {
    throw new LitigationDocxTemplateError(
      "Macros, embedded objects, ActiveX, and custom XML are not allowed.",
      "TEMPLATE_ACTIVE_CONTENT",
    );
  }
  let uncompressedBytes = 0;
  const xmlParts = names.filter(
    (name) =>
      /^word\/(document|header\d+|footer\d+)\.xml$/i.test(name) ||
      /^word\/_rels\/.*\.rels$/i.test(name),
  );
  for (const name of names) {
    const file = packageZip.file(name);
    if (!file) continue;
    const bytes = file.asUint8Array().byteLength;
    uncompressedBytes += bytes;
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new LitigationDocxTemplateError(
        "DOCX template expands beyond the 40 MB safety limit.",
        "TEMPLATE_TOO_LARGE",
      );
    }
  }
  const relationshipXml = names
    .filter((name) => name.endsWith(".rels"))
    .map((name) => packageZip.file(name)?.asText() ?? "")
    .join("\n");
  if (/TargetMode\s*=\s*["']External["']/i.test(relationshipXml)) {
    throw new LitigationDocxTemplateError(
      "External OOXML relationships are not allowed.",
      "TEMPLATE_EXTERNAL_RELATIONSHIP",
    );
  }
  const visibleText = xmlParts
    .filter((name) => !name.endsWith(".rels"))
    .map((name) => xmlText(packageZip.file(name)?.asText() ?? ""))
    .join("\n");
  const placeholders = [
    ...new Set(
      [...visibleText.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
  const unsupported = placeholders.filter(
    (field) => !ALLOWED_FIELDS.has(field),
  );
  if (unsupported.length) {
    throw new LitigationDocxTemplateError(
      `Unsupported template field(s): ${unsupported.join(", ")}`,
      "TEMPLATE_FIELD_UNSUPPORTED",
    );
  }
  if (!placeholders.includes("aletheia_body")) {
    throw new LitigationDocxTemplateError(
      "Template must contain the {aletheia_body} field.",
      "TEMPLATE_FIELD_UNSUPPORTED",
    );
  }
  try {
    new Docxtemplater(packageZip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => "",
    });
  } catch {
    throw new LitigationDocxTemplateError(
      "DOCX template fields could not be compiled.",
      "TEMPLATE_INVALID_DOCX",
    );
  }
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.length,
    placeholders,
  };
}

export function renderLitigationDocxTemplate(
  template: Buffer,
  data: Record<(typeof CUSTOM_LITIGATION_TEMPLATE_FIELDS)[number], string>,
) {
  inspectLitigationDocxTemplate(template);
  try {
    const document = new Docxtemplater(zip(template), {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => "",
    });
    document.render(data);
    return document.getZip().generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    }) as Buffer;
  } catch (error) {
    throw new LitigationDocxTemplateError(
      `DOCX template render failed: ${error instanceof Error ? error.message : String(error)}`,
      "TEMPLATE_RENDER_FAILED",
    );
  }
}
