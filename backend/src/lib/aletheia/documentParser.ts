import { writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeDocxZipPaths } from "../convert";

export type ParsedDocumentChunk = {
  chunkIndex: number;
  page: number | null;
  section: string | null;
  text: string;
  quoteStart: number;
  quoteEnd: number;
};

export type ParsedMatterDocument = {
  text: string;
  chunks: ParsedDocumentChunk[];
};

const MAX_CHUNK_LENGTH = 1200;
const CHUNK_OVERLAP = 160;

function extension(filename: string) {
  return path.extname(filename).replace(".", "").toLowerCase();
}

export function documentTypeForFilename(filename: string) {
  const ext = extension(filename);
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "doc") return "doc";
  if (ext === "txt" || ext === "md") return "text";
  return "other";
}

export function sensitiveMaterialFlagsForText(args: {
  filename?: string;
  text?: string;
}) {
  const value = `${args.filename ?? ""}\n${args.text ?? ""}`.toLowerCase();
  const flags: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["privileged", /\b(privileged|attorney[- ]client|legal advice)\b/],
    ["confidential", /\b(confidential|non[- ]disclosure|nda|trade secret)\b/],
    ["personal_data", /\b(ssn|passport|date of birth|personal data|personally identifiable|pii)\b/],
    ["financial", /\b(bank account|wire transfer|tax return|payroll|financial statement)\b/],
    ["health", /\b(health record|medical|hipaa|diagnosis|patient)\b/],
    ["minor", /\b(minor child|under 18|juvenile)\b/],
  ];

  for (const [flag, pattern] of checks) {
    if (pattern.test(value)) flags.push(flag);
  }
  return flags;
}

export async function extractMatterDocumentText(args: {
  filename: string;
  buffer: Buffer;
}) {
  const ext = extension(args.filename);
  if (ext === "pdf") return extractPdfText(args.buffer);
  if (ext === "docx" || ext === "doc") return extractDocxText(args.buffer);
  if (ext === "txt" || ext === "md") return args.buffer.toString("utf8");
  return args.buffer.toString("utf8");
}

async function extractPdfText(buffer: Buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
  const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const pdf = await (
    pdfjsLib as unknown as {
      getDocument: (opts: unknown) => {
        promise: Promise<{
          numPages: number;
          getPage: (n: number) => Promise<{
            getTextContent: () => Promise<{
              items: { str?: string }[];
            }>;
          }>;
        }>;
      };
    }
  ).getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: path.join(pdfjsRoot, "standard_fonts") + path.sep,
  }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => item.str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) pages.push(`[Page ${i}]\n${text}`);
  }
  return pages.join("\n\n");
}

async function extractDocxText(buffer: Buffer) {
  const mammoth = await import("mammoth");
  const normalized = await normalizeDocxZipPaths(buffer);
  const result = await mammoth.extractRawText({ buffer: normalized });
  return result.value.trim();
}

export function chunkMatterDocument(text: string): ParsedDocumentChunk[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];

  const chunks: ParsedDocumentChunk[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const end = Math.min(normalized.length, cursor + MAX_CHUNK_LENGTH);
    const window = normalized.slice(cursor, end);
    const breakAt = findChunkBreak(window);
    const actualEnd = end === normalized.length ? end : cursor + breakAt;
    const chunkText = normalized.slice(cursor, actualEnd).trim();
    if (chunkText) {
      chunks.push({
        chunkIndex: chunks.length,
        page: pageForOffset(normalized, cursor),
        section: null,
        text: chunkText,
        quoteStart: cursor,
        quoteEnd: actualEnd,
      });
    }
    if (actualEnd >= normalized.length) break;
    cursor = Math.max(actualEnd - CHUNK_OVERLAP, cursor + 1);
  }
  return chunks;
}

function findChunkBreak(value: string) {
  if (value.length < MAX_CHUNK_LENGTH) return value.length;
  const paragraph = value.lastIndexOf("\n\n");
  if (paragraph > 400) return paragraph;
  const sentence = Math.max(
    value.lastIndexOf(". "),
    value.lastIndexOf("? "),
    value.lastIndexOf("! "),
  );
  if (sentence > 400) return sentence + 1;
  return value.length;
}

function pageForOffset(text: string, offset: number) {
  const prefix = text.slice(0, offset);
  const matches = prefix.match(/\[Page (\d+)\]/g);
  if (!matches?.length) return null;
  const last = matches[matches.length - 1].match(/\d+/)?.[0];
  return last ? Number(last) : null;
}

export async function writeMatterDocumentFile(args: {
  documentsDir: string;
  documentId: string;
  filename: string;
  buffer: Buffer;
}) {
  const ext = extension(args.filename);
  const safeExt = ext ? `.${ext}` : "";
  const filePath = path.join(args.documentsDir, `${args.documentId}${safeExt}`);
  await writeFile(filePath, args.buffer);
  return filePath;
}
