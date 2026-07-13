import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { normalizeDocxZipPaths } from "../convert";
import {
  readProtectedLocalFileSync,
  writeProtectedLocalFileSync,
} from "./localEnvelopeCrypto";

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

export type MatterDocumentExtraction = {
  text: string;
  metadata: {
    parser: "pdf" | "pdf+apple-vision" | "docx" | "xlsx" | "deterministic";
    pageCount?: number;
    textLayerPageCount?: number;
    ocrPageCount?: number;
    ocrEngine?: "apple-vision";
    averageOcrConfidence?: number;
    ocrPages?: Array<{ page: number; confidence: number }>;
    sheetCount?: number;
    sectionCount?: number;
  };
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
  if (ext === "xlsx") return "xlsx";
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
    [
      "personal_data",
      /\b(ssn|passport|date of birth|personal data|personally identifiable|pii)\b/,
    ],
    [
      "financial",
      /\b(bank account|wire transfer|tax return|payroll|financial statement)\b/,
    ],
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
  return (await extractMatterDocument(args)).text;
}

export async function extractMatterDocument(args: {
  filename: string;
  buffer: Buffer;
}): Promise<MatterDocumentExtraction> {
  const ext = extension(args.filename);
  if (ext === "pdf") return extractPdfDocument(args.buffer);
  if (ext === "docx" || ext === "doc") {
    return {
      text: await extractDocxText(args.buffer),
      metadata: { parser: "docx" },
    };
  }
  if (ext === "xlsx") return extractXlsxDocument(args.buffer);
  if (ext === "txt" || ext === "md") {
    return {
      text: args.buffer.toString("utf8"),
      metadata: { parser: "deterministic" },
    };
  }
  return {
    text: args.buffer.toString("utf8"),
    metadata: { parser: "deterministic" },
  };
}

async function extractPdfText(buffer: Buffer) {
  return (await extractPdfDocument(buffer)).text;
}

async function extractPdfDocument(
  buffer: Buffer,
): Promise<MatterDocumentExtraction> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
  const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const workerOptions = (
    pdfjsLib as unknown as { GlobalWorkerOptions?: { workerSrc: string } }
  ).GlobalWorkerOptions;
  if (workerOptions && !workerOptions.workerSrc) {
    workerOptions.workerSrc = pathToFileURL(
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
  }
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
  const pages = new Map<number, string>();
  const missingPages: number[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => item.str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) pages.set(i, text);
    else missingPages.push(i);
  }
  let ocrPages: Array<{ page: number; text: string; confidence: number }> = [];
  if (missingPages.length > 0 && nativeOcrConfigured()) {
    ocrPages = await runNativePdfOcr(buffer, pdf.numPages);
    for (const item of ocrPages) {
      if (missingPages.includes(item.page) && item.text.trim()) {
        pages.set(item.page, item.text.trim());
      }
    }
  }
  const combined = [...pages.entries()]
    .sort(([left], [right]) => left - right)
    .map(([page, text]) => `[Page ${page}]\n${text}`)
    .join("\n\n");
  const usedOcr = ocrPages.filter(
    (item) => missingPages.includes(item.page) && item.text.trim(),
  );
  return {
    text: combined,
    metadata: {
      parser: usedOcr.length > 0 ? "pdf+apple-vision" : "pdf",
      pageCount: pdf.numPages,
      textLayerPageCount: pdf.numPages - missingPages.length,
      ocrPageCount: usedOcr.length,
      ...(usedOcr.length > 0
        ? {
            ocrEngine: "apple-vision" as const,
            averageOcrConfidence:
              usedOcr.reduce((sum, item) => sum + item.confidence, 0) /
              usedOcr.length,
            ocrPages: usedOcr.map((item) => ({
              page: item.page,
              confidence: item.confidence,
            })),
          }
        : {}),
    },
  };
}

export function nativeOcrConfigured() {
  if (process.env.ALETHEIA_OCR_ENABLED !== "true") return false;
  const binary = process.env.ALETHEIA_OCR_BINARY?.trim();
  if (!binary || !path.isAbsolute(binary)) return false;
  try {
    const info = lstatSync(binary);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function runNativePdfOcr(buffer: Buffer, pageCount: number) {
  const binary = process.env.ALETHEIA_OCR_BINARY as string;
  return new Promise<Array<{ page: number; text: string; confidence: number }>>(
    (resolve, reject) => {
      const child = spawn(binary, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { LANG: "en_US.UTF-8" },
        shell: false,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 10 * 60_000);
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 64 * 1024 * 1024) child.kill("SIGKILL");
        else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.reduce((sum, item) => sum + item.length, 0) < 8_192) {
          stderr.push(chunk);
        }
      });
      child.once("error", (error) => {
        fail(error);
      });
      child.stdin.once("error", (error: NodeJS.ErrnoException) => {
        fail(
          new Error(
            `Local OCR failed: input ${error.code || error.message}`,
          ),
        );
        child.kill("SIGKILL");
      });
      child.once("close", (code) => {
        if (settled) return;
        clearTimeout(timeout);
        if (code !== 0 || outputBytes > 64 * 1024 * 1024) {
          fail(
            new Error(
              `Local OCR failed: ${Buffer.concat(stderr).toString("utf8").replace(/\s+/g, " ").slice(0, 500) || `exit ${code}`}`,
            ),
          );
          return;
        }
        try {
          const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
          if (
            result?.schemaVersion !== "aletheia-native-ocr-v1" ||
            result?.engine !== "apple-vision" ||
            !Array.isArray(result.pages)
          ) {
            throw new Error("Local OCR returned an invalid schema.");
          }
          const seen = new Set<number>();
          const pages = result.pages.map((item: Record<string, unknown>) => {
            const page = Number(item.page);
            const confidence = Number(item.confidence);
            if (
              !Number.isInteger(page) ||
              page < 1 ||
              page > pageCount ||
              seen.has(page) ||
              typeof item.text !== "string" ||
              item.text.length > 10_000_000 ||
              !Number.isFinite(confidence) ||
              confidence < 0 ||
              confidence > 1
            ) {
              throw new Error("Local OCR returned invalid page data.");
            }
            seen.add(page);
            return { page, text: item.text, confidence };
          });
          settled = true;
          resolve(pages);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stdin.end(buffer);
    },
  );
}

async function extractDocxText(buffer: Buffer) {
  const mammoth = await import("mammoth");
  const normalized = await normalizeDocxZipPaths(buffer);
  const result = await mammoth.extractRawText({ buffer: normalized });
  return result.value.trim();
}

async function extractXlsxDocument(
  buffer: Buffer,
): Promise<MatterDocumentExtraction> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  const sections: string[] = [];
  workbook.eachSheet((worksheet) => {
    const rows: string[] = [];
    worksheet.eachRow((row, rowNumber) => {
      const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
      const text = cells
        .map((cell) => cellText(cell))
        .filter(Boolean)
        .join(" | ");
      if (text) rows.push(`Row ${rowNumber}: ${text}`);
    });
    if (rows.length) {
      sections.push(`[Sheet ${worksheet.name}]\n${rows.join("\n")}`);
    }
  });
  return {
    text: sections.join("\n\n"),
    metadata: {
      parser: "xlsx",
      sheetCount: workbook.worksheets.length,
      sectionCount: sections.length,
    },
  };
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).trim();
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text.trim();
    if (
      typeof record.result === "string" ||
      typeof record.result === "number"
    ) {
      return String(record.result).trim();
    }
    if (
      typeof record.hyperlink === "string" &&
      typeof record.text === "string"
    ) {
      return record.text.trim();
    }
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((item) =>
          item && typeof item === "object" && "text" in item
            ? String((item as { text?: unknown }).text ?? "")
            : "",
        )
        .join("")
        .trim();
    }
  }
  return "";
}

export function chunkMatterDocument(text: string): ParsedDocumentChunk[] {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return [];

  const chunks: ParsedDocumentChunk[] = [];
  for (const region of pageRegions(normalized)) {
    let cursor = region.start;
    while (cursor < region.end) {
      const end = Math.min(region.end, cursor + MAX_CHUNK_LENGTH);
      const window = normalized.slice(cursor, end);
      const breakAt = findChunkBreak(window);
      const actualEnd = end === region.end ? end : cursor + breakAt;
      const chunkText = normalized.slice(cursor, actualEnd).trim();
      if (chunkText) {
        chunks.push({
          chunkIndex: chunks.length,
          page: region.page,
          section: null,
          text: chunkText,
          quoteStart: cursor,
          quoteEnd: actualEnd,
        });
      }
      if (actualEnd >= region.end) break;
      cursor = Math.max(actualEnd - CHUNK_OVERLAP, cursor + 1);
    }
  }
  return chunks;
}

function pageRegions(text: string) {
  const matches = [...text.matchAll(/\[Page (\d+)\]/g)];
  if (matches.length === 0) {
    return [{ start: 0, end: text.length, page: null as number | null }];
  }
  const regions: Array<{ start: number; end: number; page: number | null }> = [];
  const firstStart = matches[0].index ?? 0;
  if (firstStart > 0) {
    regions.push({ start: 0, end: firstStart, page: null });
  }
  matches.forEach((match, index) => {
    regions.push({
      start: match.index ?? 0,
      end: matches[index + 1]?.index ?? text.length,
      page: Number(match[1]),
    });
  });
  return regions;
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

export async function writeMatterDocumentFile(args: {
  documentsDir: string;
  documentId: string;
  filename: string;
  buffer: Buffer;
}) {
  const ext = extension(args.filename);
  const safeExt = ext ? `.${ext}` : "";
  const filePath = path.join(args.documentsDir, `${args.documentId}${safeExt}`);
  writeProtectedLocalFileSync({
    filePath,
    plaintext: args.buffer,
    purpose: "source_document",
  });
  return filePath;
}

export function readMatterDocumentFile(filePath: string) {
  return readProtectedLocalFileSync({
    filePath,
    purpose: "source_document",
  });
}
