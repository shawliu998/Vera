import type { DocumentStudioDraftTypeV20 } from "./documentStudioDraftMetadataV20";
import type { WorkspaceDatabaseAdapter } from "./migrations";
import type { TabularReviewDetail } from "./repositories/tabular";
import {
  canonicalJsonV23,
  prepareTabularReviewStudioSourceV23,
  readTabularReviewStudioJobLineageV23,
  reduceTabularReviewToContractMemoV23,
} from "./tabularReviewStudioHandoffV23";

export const TABULAR_STUDIO_HANDOFF_KINDS = [
  "contract_review_memo",
  "case_fact_summary",
  "custom_extraction_summary",
] as const;

export type TabularStudioHandoffKind =
  (typeof TABULAR_STUDIO_HANDOFF_KINDS)[number];

export type PreparedTabularStudioHandoff = Readonly<{
  kind: TabularStudioHandoffKind;
  detail: TabularReviewDetail;
  source: ReturnType<typeof prepareTabularReviewStudioSourceV23>;
}>;

export type TabularStudioReducedDraft = Readonly<{
  title: string;
  content: string;
  documentType: DocumentStudioDraftTypeV20;
}>;

export type TabularStudioCitationSource =
  PreparedTabularStudioHandoff["source"]["orderedUniqueSources"][number] &
    Readonly<{
      locator: Readonly<{ startOffset: number; endOffset: number }>;
      rank: number;
      score: null;
      citationOrdinal: number;
      citationMetadata: Readonly<{ citationNumber: number }>;
    }>;

const MAX_MEMO_CHARS = 90_000;

export function prepareTabularStudioHandoff(input: {
  database: WorkspaceDatabaseAdapter;
  projectId: string;
  detail: TabularReviewDetail;
  kind: TabularStudioHandoffKind;
}): PreparedTabularStudioHandoff {
  const jobLineage = readTabularReviewStudioJobLineageV23({
    database: input.database,
    projectId: input.projectId,
    detail: input.detail,
  });
  return {
    kind: input.kind,
    detail: input.detail,
    source: prepareTabularReviewStudioSourceV23({
      projectId: input.projectId,
      detail: input.detail,
      jobLineage,
      requireWorkflowBound: input.kind === "contract_review_memo",
    }),
  };
}

function cleanMemoText(value: string) {
  return (
    value
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 2_000)
      // Only evidenceIndex emits durable Studio citation markers.  Normal Review
      // text can itself contain legal references such as "[12]", which must not
      // be mistaken for an anchor by the Studio runtime.
      .replace(/\[(\d+)\]/gu, "［$1］")
  );
}

function cellText(cell: TabularReviewDetail["cells"][number] | undefined) {
  if (!cell) return "Not found";
  if (cell.content?.summary.trim()) return cell.content.summary.trim();
  if (typeof cell.value === "string" && cell.value.trim()) {
    return cell.value.trim();
  }
  if (typeof cell.value === "number" || typeof cell.value === "boolean") {
    return String(cell.value);
  }
  return "Not found";
}

function escapeTableCell(value: string) {
  return value
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>")
    .slice(0, 2_000)
    .replace(/\[(\d+)\]/gu, "［$1］");
}

function missingMemoValue(value: string) {
  return /^(?:not found|none identified|unknown|n\/a|未发现|未找到|无|未知)$/iu.test(
    value.trim(),
  );
}

function reviewRoute(projectId: string, reviewId: string) {
  return `/projects/${projectId}/tabular-reviews/${reviewId}`;
}

function evidenceIndex(prepared: PreparedTabularStudioHandoff) {
  const documentNumber = new Map(
    prepared.detail.review.documentIds.map((documentId, index) => [
      documentId,
      index + 1,
    ]),
  );
  return prepared.source.orderedUniqueSources.map(
    (source, index) =>
      `- [${index + 1}] 来源材料 ${documentNumber.get(source.documentId) ?? "未知"}，持久化原文：${cleanMemoText(source.quote)}`,
  );
}

/**
 * Keeps the evidence section at the end of general Studio drafts so a size
 * limit can never leave a partial marker behind.  The returned entries are
 * always a contiguous prefix, so their [n] markers match the source records
 * passed to Studio by createStudioDraftFromTabular.
 */
function withBoundedEvidenceSection(input: {
  prefix: string;
  evidenceHeading: string;
  prepared: PreparedTabularStudioHandoff;
  suffix: readonly string[];
}) {
  const entries = evidenceIndex(input.prepared);
  const opening = `\n\n${input.evidenceHeading}\n\n`;
  const closing = `\n\n${input.suffix.join("\n")}`;
  // Reserve a complete first entry before trimming the body. Every evidence
  // quote is bounded by cleanMemoText, so this also guarantees progress for a
  // valid source list.
  const reserved = opening.length + closing.length + (entries[0]?.length ?? 0);
  let content = input.prefix.slice(0, Math.max(0, MAX_MEMO_CHARS - reserved));
  content += opening;
  for (const entry of entries) {
    const separator = content.endsWith("\n\n") ? "" : "\n";
    if (
      content.length + separator.length + entry.length + closing.length >
      MAX_MEMO_CHARS
    ) {
      break;
    }
    content += `${separator}${entry}`;
  }
  return `${content}${closing}`;
}

function visibleCitationCount(content: string) {
  const numbers = [...content.matchAll(/\[(\d+)\]/gu)].map((match) =>
    Number(match[1]),
  );
  if (!numbers.every((number, index) => number === index + 1)) {
    throw new Error(
      "Tabular Studio evidence markers are not a contiguous prefix.",
    );
  }
  return numbers.length;
}

function reduceTimeline(
  prepared: PreparedTabularStudioHandoff,
  title: string,
  projectId: string,
): TabularStudioReducedDraft {
  const detail = prepared.detail;
  const columnIds = new Map(
    detail.columns.map((column) => [
      column.title.toLocaleLowerCase(),
      column.id,
    ]),
  );
  const valueFor = (documentId: string, columnTitle: string) => {
    const columnId = columnIds.get(columnTitle.toLocaleLowerCase());
    return cleanMemoText(
      cellText(
        columnId
          ? detail.cells.find(
              (cell) =>
                cell.documentId === documentId && cell.columnId === columnId,
            )
          : undefined,
      ),
    );
  };
  const rows = detail.review.documentIds.map((documentId, index) => ({
    sourceNumber: index + 1,
    date: valueFor(documentId, "Date"),
    event: valueFor(documentId, "Event"),
    participants: valueFor(documentId, "Participants"),
    source: valueFor(documentId, "Source file"),
    evidence: valueFor(documentId, "Original evidence"),
    significance: valueFor(documentId, "Potential significance"),
    questions: valueFor(documentId, "Open questions"),
  }));
  const sourceLabel = (row: (typeof rows)[number]) =>
    missingMemoValue(row.source) ? `来源材料 ${row.sourceNumber}` : row.source;
  const eventRows = rows.filter((row) => !missingMemoValue(row.event));
  const participantValues = [
    ...new Map(
      rows
        .filter((row) => !missingMemoValue(row.participants))
        .map((row) => [row.participants.toLocaleLowerCase(), row.participants]),
    ).values(),
  ];
  const supportedFacts = eventRows.filter(
    (row) => !missingMemoValue(row.evidence),
  );
  const gaps = eventRows.flatMap((row) => {
    const items: string[] = [];
    if (missingMemoValue(row.date)) {
      items.push(`事件缺少明确日期：${row.event}（${sourceLabel(row)}）`);
    }
    if (missingMemoValue(row.evidence)) {
      items.push(`事件缺少可用原文依据：${row.event}（${sourceLabel(row)}）`);
    }
    return items;
  });
  const incompleteRows = rows.filter((row) => missingMemoValue(row.event));
  const incompleteCells = detail.cells.filter((cell) =>
    ["failed", "cancelled"].includes(cell.status),
  );
  const confirmationItems = rows
    .filter((row) => !missingMemoValue(row.questions))
    .map(
      (row) =>
        `${row.questions}（${missingMemoValue(row.event) ? sourceLabel(row) : row.event}）`,
    );
  const bullets = (items: readonly string[], empty: string) =>
    items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${empty}`];
  const timeline = eventRows.map((row) => {
    const date = missingMemoValue(row.date) ? "日期未发现" : row.date;
    const significance = missingMemoValue(row.significance)
      ? ""
      : `；可能意义：${row.significance}`;
    return `- **${date}** — ${row.event}（${sourceLabel(row)}${significance}）`;
  });
  const facts = supportedFacts.map(
    (row) => `- ${row.event}（${sourceLabel(row)}；原文依据：${row.evidence}）`,
  );
  const missing = [
    ...incompleteRows.map((row) => `${sourceLabel(row)}未提取到明确事件。`),
    ...(incompleteCells.length > 0
      ? [`有 ${incompleteCells.length} 个提取单元未成功完成。`]
      : []),
  ];
  const lines = [
    `# ${cleanMemoText(title)}`,
    "",
    `本摘要仅整理已完成结构化 Review [${cleanMemoText(detail.review.title)}](${reviewRoute(projectId, detail.review.id)}) 中持久化的单元结果，不补充或推测材料外事实。`,
    "",
    "## 材料范围",
    "",
    `- Review 材料数：${detail.review.documentIds.length}`,
    `- 已完成提取单元：${detail.cells.filter((cell) => cell.status === "complete").length}/${detail.cells.length}`,
    "",
    "## 核心时间线",
    "",
    ...bullets(timeline, "未从 Review 中提取到明确事件。"),
    "",
    "## 主要参与方",
    "",
    ...bullets(participantValues, "未发现明确参与方。"),
    "",
    "## 已明确事实",
    "",
    ...bullets(facts, "未发现同时具有明确事件和原文依据的记录。"),
    "",
    "## 存在矛盾或材料缺口",
    "",
    "- 本摘要不自动推断材料之间是否矛盾；以下仅列示 Review 中可直接识别的缺口。",
    ...bullets(gaps, "未识别到缺少日期或原文依据的事件。"),
    "",
    "## 缺失材料",
    "",
    ...bullets(missing, "Review 未标记具体缺失材料。"),
    "",
    "## 待律师确认事项",
    "",
    ...bullets(confirmationItems, "Review 未提取到明确待确认事项。"),
    "",
  ];
  return {
    title,
    content: withBoundedEvidenceSection({
      prefix: lines.join("\n"),
      evidenceHeading: "## 证据引用",
      prepared,
      suffix: [
        "请在对外使用前回到 Review 和源文件核对日期、原文及材料完整性。",
      ],
    }),
    documentType: "general_legal_document",
  };
}

function reduceCustomExtraction(
  prepared: PreparedTabularStudioHandoff,
  title: string,
  projectId: string,
): TabularStudioReducedDraft {
  const detail = prepared.detail;
  const columns = [...detail.columns].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const lines = [
    `# ${cleanMemoText(title)}`,
    "",
    `This memo summarizes the completed structured review [${cleanMemoText(detail.review.title)}](${reviewRoute(projectId, detail.review.id)}).`,
    "",
    `| Source document | ${columns.map((column) => escapeTableCell(column.title)).join(" | ")} |`,
    `| --- | ${columns.map(() => "---").join(" | ")} |`,
  ];
  let omitted = 0;
  detail.review.documentIds.forEach((documentId, documentIndex) => {
    const row = [
      `Source document ${documentIndex + 1}`,
      ...columns.map((column) =>
        escapeTableCell(
          cellText(
            detail.cells.find(
              (cell) =>
                cell.documentId === documentId && cell.columnId === column.id,
            ),
          ),
        ),
      ),
    ];
    const line = `| ${row.join(" | ")} |`;
    if (lines.join("\n").length + line.length <= MAX_MEMO_CHARS - 2_000) {
      lines.push(line);
    } else {
      omitted += 1;
    }
  });
  if (omitted > 0) {
    lines.push(
      "",
      `_${omitted} additional source-document rows remain available in the linked Review._`,
    );
  }
  return {
    title,
    content: withBoundedEvidenceSection({
      prefix: lines.join("\n"),
      evidenceHeading: "## Evidence citations",
      prepared,
      suffix: [
        "## Follow-up",
        "",
        "Confirm material gaps and conclusions against the linked Review and source documents before relying on this memo.",
      ],
    }),
    documentType: "general_legal_document",
  };
}

export function reduceTabularStudioHandoff(
  prepared: PreparedTabularStudioHandoff,
  input: Readonly<{ projectId: string; title?: string }>,
): TabularStudioReducedDraft {
  if (prepared.kind === "contract_review_memo") {
    return {
      ...reduceTabularReviewToContractMemoV23(prepared.source),
      documentType: "contract_review_memo",
    };
  }
  const title =
    input.title ??
    (prepared.kind === "case_fact_summary"
      ? `${prepared.detail.review.title} — 案件事实摘要`
      : `${prepared.detail.review.title} Memo`);
  return prepared.kind === "case_fact_summary"
    ? reduceTimeline(prepared, title, input.projectId)
    : reduceCustomExtraction(prepared, title, input.projectId);
}

export async function createStudioDraftFromTabular<T>(input: {
  prepared: PreparedTabularStudioHandoff;
  projectId: string;
  title?: string;
  create: (
    draft: TabularStudioReducedDraft,
    citations: readonly TabularStudioCitationSource[],
  ) => Promise<T>;
}): Promise<T> {
  const draft = reduceTabularStudioHandoff(input.prepared, {
    projectId: input.projectId,
    title: input.title,
  });
  const sources = input.prepared.source.orderedUniqueSources;
  if (
    new Set(sources.map((source) => canonicalJsonV23(source))).size !==
    sources.length
  ) {
    throw new Error("Tabular Studio citations are not unique.");
  }
  const visibleSources =
    input.prepared.kind === "contract_review_memo"
      ? sources
      : sources.slice(0, visibleCitationCount(draft.content));
  const citations = visibleSources.map((source, index) => ({
    ...source,
    locator: {
      startOffset: source.startOffset,
      endOffset: source.endOffset,
    },
    rank: index,
    score: null,
    citationOrdinal: index,
    citationMetadata: { citationNumber: index + 1 },
  }));
  return input.create(draft, citations);
}
