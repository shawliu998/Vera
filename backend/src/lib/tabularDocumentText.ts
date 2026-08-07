import { docxToPdf, normalizeDocxZipPaths } from "./convert";
import {
  isPresentationDocumentType,
  isSpreadsheetDocumentType,
  isWordDocumentType,
} from "./documentTypes";
import { extractPresentationText } from "./officeText";
import { spreadsheetToLLMText } from "./spreadsheet";

export async function extractTabularDocumentText(
  buffer: ArrayBuffer,
  fileType: string | null | undefined,
) {
  const normalizedType = (fileType ?? "").toLowerCase();
  if (normalizedType === "pdf") return extractPdfText(buffer);
  if (normalizedType === "docx") return extractDocxText(buffer);
  if (isSpreadsheetDocumentType(normalizedType)) {
    return spreadsheetToLLMText(Buffer.from(buffer));
  }
  if (normalizedType === "pptx") {
    return extractPresentationText(Buffer.from(buffer));
  }
  if (
    isPresentationDocumentType(normalizedType) ||
    isWordDocumentType(normalizedType)
  ) {
    const pdf = await docxToPdf(Buffer.from(buffer));
    return extractPdfText(
      pdf.buffer.slice(
        pdf.byteOffset,
        pdf.byteOffset + pdf.byteLength,
      ) as ArrayBuffer,
    );
  }
  return extractDocxText(buffer);
}

async function extractPdfText(buffer: ArrayBuffer) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjs as unknown as {
        getDocument: (options: unknown) => {
          promise: Promise<{
            numPages: number;
            getPage: (page: number) => Promise<{
              getTextContent: () => Promise<{
                items: { str?: string; hasEOL?: boolean }[];
              }>;
            }>;
          }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .filter((item): item is { str: string } => "str" in item)
        .map((item) => item.str)
        .join(" ")
        .trim();
      if (text) pages.push(`## Page ${pageNumber}\n\n${text}`);
    }
    return pages.join("\n\n");
  } catch {
    return "";
  }
}

async function extractDocxText(buffer: ArrayBuffer) {
  try {
    const mammoth = await import("mammoth");
    const normalized = await normalizeDocxZipPaths(Buffer.from(buffer));
    const { value: html } = await mammoth.convertToHtml({ buffer: normalized });
    return html
      .replace(
        /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
        (_, level, text) => "#".repeat(Number(level)) + " " + text + "\n\n",
      )
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
      .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
      .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return "";
  }
}
