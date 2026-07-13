import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import {
  DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_ID,
  DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_VERSION,
  resolveLitigationDocumentTemplate,
} from "./litigationDocumentTemplates";

type RecordValue = Record<string, unknown>;

const PAGE_MARGIN_DXA = 1_440;
const HEADER_FOOTER_DXA = 709;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function text(value: unknown, maximum = 20_000) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : null;
}

function dateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function positionLabel(value: unknown) {
  const normalized = text(value, 80);
  if (!normalized) return null;
  const labels: Record<string, string> = {
    support: "支持",
    adverse: "不利",
    neutral: "中性",
    uncertain: "存在不确定性",
  };
  return labels[normalized] ?? normalized;
}

function metadataRow(label: string, value: string | null) {
  if (!value) return null;
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}：`, bold: true, color: "374151" }),
      new TextRun({ text: value, color: "374151" }),
    ],
    spacing: { after: 50, line: 264 },
  });
}

function citationParagraphs(rawCitations: unknown) {
  const citations = Array.isArray(rawCitations) ? rawCitations : [];
  if (!citations.length) {
    return [
      new Paragraph({
        text: "本结论未附可出具引用，不能作为正式法律意见的依据。",
        spacing: { after: 120 },
      }),
    ];
  }
  return citations.flatMap((rawCitation, index) => {
    const citation = record(rawCitation);
    const sourceType = text(citation.sourceType, 80) ?? "本地来源快照";
    const snapshotId = text(citation.snapshotId, 160) ?? "未标识快照";
    const effectiveFrom = text(citation.effectiveFrom, 40);
    const effectiveTo = text(citation.effectiveTo, 40);
    const caseVerification = text(citation.caseVerificationStatus, 40);
    const metadata = [
      `${index + 1}. ${sourceType}`,
      `快照 ${snapshotId}`,
      effectiveFrom ? `适用起始 ${effectiveFrom}` : null,
      effectiveTo ? `适用截至 ${effectiveTo}` : null,
      caseVerification ? `案号核验 ${caseVerification}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const quote = text(citation.quote, 20_000);
    return [
      new Paragraph({
        children: [new TextRun({ text: metadata, bold: true, size: 20, color: "4B5563" })],
        spacing: { before: 80, after: 40 },
      }),
      ...(quote
        ? [
            new Paragraph({
              children: [new TextRun({ text: `“${quote}”`, italics: true, size: 20 })],
              indent: { left: 360, right: 240 },
              spacing: { after: 100, line: 264 },
            }),
          ]
        : []),
    ];
  });
}

function findingParagraphs(rawFindings: unknown) {
  const findings = Array.isArray(rawFindings) ? rawFindings : [];
  if (!findings.length) {
    throw new Error("A legal opinion requires at least one accepted research finding.");
  }
  return findings.flatMap((rawFinding, index) => {
    const finding = record(rawFinding);
    const conclusion = text(finding.conclusion, 20_000);
    if (!conclusion) {
      throw new Error("A legal opinion finding is missing its accepted conclusion.");
    }
    const summary: Array<[string, string | null]> = [
      ["观点", positionLabel(finding.position)],
      ["可信度", text(finding.confidence, 80)],
      ["不确定性", text(finding.uncertainty, 4_000)],
    ];
    return [
      new Paragraph({ text: `结论 ${index + 1}`, heading: HeadingLevel.HEADING_2 }),
      new Paragraph({ text: conclusion, spacing: { after: 80, line: 290 } }),
      ...summary
        .map(([label, value]) => metadataRow(label, value))
        .filter((paragraph): paragraph is Paragraph => Boolean(paragraph)),
      new Paragraph({ text: "引用依据", heading: HeadingLevel.HEADING_3 }),
      ...citationParagraphs(finding.citations),
    ];
  });
}

export async function buildLegalOpinionDocx(args: {
  title: string;
  matterId: string;
  version: number;
  contentHash: string;
  exportedAt: string;
  content: RecordValue;
}) {
  const template = resolveLitigationDocumentTemplate(
    DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_ID,
    DEFAULT_LITIGATION_DOCUMENT_TEMPLATE_VERSION,
  );
  if (!template || template.locale !== "zh-CN") {
    throw new Error("The approved Chinese legal-opinion template is unavailable.");
  }
  // The approved workpaper template is PingFang-based. Hiragino Sans GB is the
  // compatible macOS Word/LibreOffice export face used for the formal opinion.
  const chineseFont = {
    ascii: "Hiragino Sans GB",
    hAnsi: "Hiragino Sans GB",
    eastAsia: "Hiragino Sans GB",
    cs: "Hiragino Sans GB",
  };

  const cover = record(args.content.cover);
  const sections = Array.isArray(args.content.sections) ? args.content.sections : [];
  const sectionFor = (heading: string) =>
    record(sections.find((section) => record(section).heading === heading));
  const scope = sectionFor("意见范围");
  const findingsSection = sectionFor("已采纳研究结论");
  const limitation = sectionFor("适用限定");
  const body: Paragraph[] = [
    new Paragraph({ text: "法律意见书", heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [new TextRun({ text: args.title, size: 26, color: "374151" })],
      spacing: { after: 220, line: 264 },
    }),
    ...[
      metadataRow("致", text(cover.addressee, 240)),
      metadataRow("律师参考编号", text(cover.lawyerReference, 240)),
      metadataRow("版本", `v${args.version}`),
      metadataRow("出具时间", dateTime(args.exportedAt)),
      metadataRow(
        "核验标识",
        `案件 ${args.matterId} · 内容 ${args.contentHash.slice(0, 24)}…`,
      ),
    ].filter((paragraph): paragraph is Paragraph => Boolean(paragraph)),
    new Paragraph({ text: "意见范围", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({
      text:
        text(scope.text, 4_000) ??
        "本法律意见书仅呈现已采纳、已复核的本地法律研究结论；不新增、修改或替代该等结论及引用。",
      spacing: { after: 120, line: 290 },
    }),
    new Paragraph({ text: "已采纳研究结论", heading: HeadingLevel.HEADING_1 }),
    ...findingParagraphs(findingsSection.findings),
    new Paragraph({ text: "适用限定", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({
      text:
        text(cover.limitation, 4_000) ??
        text(limitation.text, 4_000) ??
        "本意见书以所绑定研究备忘录、争点树、输入清单和来源快照在导出时仍然有效为前提。",
      spacing: { after: 120, line: 290 },
    }),
  ];

  const document = new Document({
    creator: "Vera",
    title: args.title,
    subject: "法律意见书",
    description: `Matter ${args.matterId}; version ${args.version}; approval-bound local legal opinion.`,
    styles: {
      default: {
        document: {
          run: { font: chineseFont, size: 22, color: "1F2937" },
          paragraph: { spacing: { line: 290, after: 120 } },
        },
      },
      paragraphStyles: [
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: chineseFont, size: 48, bold: true, color: "111827" },
          paragraph: { spacing: { before: 0, after: 80 }, keepNext: true },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: chineseFont, size: 32, bold: true, color: "1F2937" },
          paragraph: { spacing: { before: 320, after: 160 }, keepNext: true },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: chineseFont, size: 26, bold: true, color: "374151" },
          paragraph: { spacing: { before: 220, after: 100 }, keepNext: true },
        },
        {
          id: "Heading3",
          name: "Heading 3",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: chineseFont, size: 22, bold: true, color: "4B5563" },
          paragraph: { spacing: { before: 120, after: 60 }, keepNext: true },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: PAGE_MARGIN_DXA,
              right: PAGE_MARGIN_DXA,
              bottom: PAGE_MARGIN_DXA,
              left: PAGE_MARGIN_DXA,
              header: HEADER_FOOTER_DXA,
              footer: HEADER_FOOTER_DXA,
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: "Vera", bold: true, size: 18, color: "4B5563" }),
                  new TextRun({
                    text: "  本地法律意见书",
                    font: chineseFont,
                    size: 18,
                    color: "6B7280",
                  }),
                ],
                spacing: { after: 40 },
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                text: "保密 · 律师审批后的本地导出",
                alignment: AlignmentType.CENTER,
                spacing: { before: 40 },
              }),
            ],
          }),
        },
        children: body,
      },
    ],
  });
  return Packer.toBuffer(document);
}
