import { extractDocxBodyText } from "./docxTrackedChanges";
import { isSpreadsheetDocumentType } from "./documentTypes";
import { extractPdfText } from "./chat/tools/documentOps";
import {
  spreadsheetCitationText,
  spreadsheetToLLMText,
} from "./spreadsheet";
import { downloadFile } from "./storage";
import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type AgentEvidenceStatus =
  | "exact"
  | "drifted"
  | "missing"
  | "version_mismatch";

export type CitationQuote = {
  page: number | string | null;
  quote: string;
  sheet: string | null;
  cell: string | null;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function quotedAnchorLocated(
  sourceText: string | null,
  quote: string,
) {
  const anchor = normalize(quote).slice(0, 120);
  return Boolean(sourceText && anchor && normalize(sourceText).includes(anchor));
}

export function pdfCitationPageText(
  sourceText: string,
  page: number | string | null,
) {
  const rawPage = typeof page === "number" ? String(page) : page?.trim() ?? "";
  const match = rawPage.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2] ?? match[1], 10);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start ||
    end - start > 49
  ) {
    return null;
  }

  const pageText = new Map<number, string>();
  const sectionPattern =
    /(?:^|\n\n)\[Page ([1-9]\d*)\]\n([\s\S]*?)(?=\n\n\[Page [1-9]\d*\]\n|$)/g;
  for (const section of sourceText.matchAll(sectionPattern)) {
    pageText.set(Number.parseInt(section[1], 10), section[2]);
  }
  const selected: string[] = [];
  for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
    const text = pageText.get(pageNumber);
    if (text === undefined) return null;
    selected.push(text);
  }
  return selected.join("\n\n");
}

function citationQuotes(row: Record<string, unknown>): CitationQuote[] {
  const nested = Array.isArray(row.quotes) ? row.quotes : [];
  const quotes = nested.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const quote = entry as Record<string, unknown>;
    return [
      {
        page:
          typeof quote.page === "number" || typeof quote.page === "string"
            ? quote.page
            : null,
        quote: text(quote.quote),
        sheet: text(quote.sheet) || null,
        cell: text(quote.cell) || null,
      },
    ];
  });
  if (quotes.length) return quotes;
  return [
    {
      page:
        typeof row.page === "number" || typeof row.page === "string"
          ? row.page
          : null,
      quote: text(row.quote),
      sheet: text(row.sheet) || null,
      cell: text(row.cell) || null,
    },
  ];
}

export type ExtractedVersionContent = {
  text: string;
  spreadsheet: Buffer | null;
  pdf: boolean;
};

export function classifyAgentCitationRelocation(input: {
  source: ExtractedVersionContent | null;
  quote: CitationQuote;
  versionId: string;
  currentVersionId: string | null;
}): { status: AgentEvidenceStatus; detail: string } {
  if (!input.quote.quote) {
    return {
      status: "missing",
      detail: "Citation data or its source is missing.",
    };
  }
  if (!input.source) {
    return {
      status: "missing",
      detail: "The cited source version content is unavailable.",
    };
  }

  let relocationText: string | null;
  if (input.source.spreadsheet) {
    relocationText =
      input.quote.sheet && input.quote.cell
        ? spreadsheetCitationText(
            input.source.spreadsheet,
            input.quote.sheet,
            input.quote.cell,
          )
        : null;
  } else if (input.source.pdf) {
    relocationText = pdfCitationPageText(input.source.text, input.quote.page);
    if (relocationText === null) {
      return {
        status: "missing",
        detail: "The cited PDF page or page range is missing or invalid.",
      };
    }
  } else {
    // DOCX extraction has no reliable page boundaries, so retain the existing
    // full-document quote check instead of inventing a page locator.
    relocationText = input.source.text;
  }
  if (!quotedAnchorLocated(relocationText, input.quote.quote)) {
    return {
      status: "drifted",
      detail: input.source.spreadsheet
        ? "The quoted anchor could not be relocated at the cited sheet and cell."
        : input.source.pdf
          ? "The quoted anchor could not be relocated on the cited PDF page or page range."
          : "Source opened, but the quoted anchor could not be relocated.",
    };
  }
  if (input.currentVersionId !== input.versionId) {
    return {
      status: "version_mismatch",
      detail:
        "Located in the cited version; the source now has a newer current version.",
    };
  }
  return {
    status: "exact",
    detail: "Located in the cited source version.",
  };
}

export async function extractVersionContent(version: {
  storage_path: string | null;
  file_type: string | null;
}): Promise<ExtractedVersionContent | null> {
  if (!version.storage_path) return null;
  try {
    const raw = await downloadFile(version.storage_path);
    if (!raw) return null;
    const fileType = (version.file_type ?? "").toLowerCase();
    if (fileType === "pdf") {
      return { text: await extractPdfText(raw), spreadsheet: null, pdf: true };
    }
    if (fileType === "docx" || fileType === "doc") {
      return {
        text: await extractDocxBodyText(Buffer.from(raw)),
        spreadsheet: null,
        pdf: false,
      };
    }
    if (isSpreadsheetDocumentType(fileType)) {
      const spreadsheet = Buffer.from(raw);
      return {
        text: spreadsheetToLLMText(spreadsheet),
        spreadsheet,
        pdf: false,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function getAgentTaskEvidence(
  db: Db,
  input: {
    taskId: string;
    artifactId: string;
    userId: string;
  },
) {
  const { data: task } = await db
    .from("agent_tasks")
    .select("id")
    .eq("id", input.taskId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (!task) return null;

  const { data: artifact } = await db
    .from("agent_artifact_links")
    .select("artifact_id")
    .eq("task_id", input.taskId)
    .eq("artifact_type", "citation_snapshot")
    .eq("artifact_id", input.artifactId)
    .maybeSingle();
  if (!artifact) return null;

  const [{ data: message, error: messageError }, { data: linkedDocuments }] =
    await Promise.all([
      db
        .from("chat_messages")
        .select("id,citations")
        .eq("id", input.artifactId)
        .maybeSingle(),
      db
        .from("agent_artifact_links")
        .select("artifact_id,artifact_type")
        .eq("task_id", input.taskId)
        .in("artifact_type", ["document", "draft", "tabular_review"]),
    ]);
  if (messageError) throw new Error(messageError.message);
  if (!message) return null;

  const rawCitations = Array.isArray(message.citations)
    ? message.citations
    : [];
  const allowedDocumentIds = new Set(
    (linkedDocuments ?? []).map((source) => source.artifact_id as string),
  );
  const documentIds = Array.from(
    new Set(
      rawCitations.flatMap((citation) => {
        if (!citation || typeof citation !== "object") return [];
        const documentId = text(
          (citation as Record<string, unknown>).document_id,
        );
        return documentId ? [documentId] : [];
      }),
    ),
  );
  const versionIds = Array.from(
    new Set(
      rawCitations.flatMap((citation) => {
        if (!citation || typeof citation !== "object") return [];
        const versionId = text(
          (citation as Record<string, unknown>).version_id,
        );
        return versionId ? [versionId] : [];
      }),
    ),
  );

  const [{ data: documents }, { data: versions }] = await Promise.all([
    documentIds.length
      ? db
          .from("documents")
          .select("id,current_version_id")
          .in("id", documentIds)
          .eq("user_id", input.userId)
      : Promise.resolve({ data: [] }),
    versionIds.length
      ? db
          .from("document_versions")
          .select(
            "id,document_id,storage_path,version_number,filename,file_type,deleted_at",
          )
          .in("id", versionIds)
      : Promise.resolve({ data: [] }),
  ]);
  const documentById = new Map(
    (documents ?? []).map((document) => [document.id as string, document]),
  );
  const versionById = new Map(
    (versions ?? []).map((version) => [version.id as string, version]),
  );
  const extractedByVersion = new Map<
    string,
    Promise<ExtractedVersionContent | null>
  >();

  const citations = [];
  for (const [citationIndex, rawCitation] of rawCitations.entries()) {
    const row =
      rawCitation && typeof rawCitation === "object"
        ? (rawCitation as Record<string, unknown>)
        : {};
    const documentId = text(row.document_id) || null;
    const versionId = text(row.version_id) || null;
    const document = documentId ? documentById.get(documentId) : null;
    const version = versionId ? versionById.get(versionId) : null;
    const quotes = citationQuotes(row);

    for (const [quoteIndex, quote] of quotes.entries()) {
      let status: AgentEvidenceStatus = "missing";
      let detail = "Citation data or its source is missing.";
      const sourceAllowed = Boolean(
        documentId && allowedDocumentIds.has(documentId),
      );
      const versionAvailable = Boolean(
        document &&
        version &&
        !version.deleted_at &&
        version.document_id === documentId,
      );

      if (sourceAllowed && versionAvailable && quote.quote) {
        const key = versionId as string;
        let extracted = extractedByVersion.get(key);
        if (!extracted) {
          extracted = extractVersionContent({
            storage_path: (version?.storage_path as string | null) ?? null,
            file_type: (version?.file_type as string | null) ?? null,
          });
          extractedByVersion.set(key, extracted);
        }
        const source = await extracted;
        ({ status, detail } = classifyAgentCitationRelocation({
          source,
          quote,
          versionId: key,
          currentVersionId:
            (document?.current_version_id as string | null) ?? null,
        }));
      }

      citations.push({
        id: `${input.artifactId}:${citationIndex}:${quoteIndex}`,
        ref: typeof row.ref === "number" ? row.ref : null,
        document_id: documentId,
        version_id: versionId,
        current_version_id:
          (document?.current_version_id as string | null) ?? null,
        version_number: (version?.version_number as number | null) ?? null,
        filename:
          text(version?.filename) || "Source document",
        file_type:
          text(version?.file_type) || null,
        page: quote.page,
        quote: quote.quote,
        sheet: quote.sheet,
        cell: quote.cell,
        status,
        detail,
        openable: Boolean(sourceAllowed && versionAvailable && documentId),
      });
    }
  }

  return { artifact_id: input.artifactId, citations };
}
