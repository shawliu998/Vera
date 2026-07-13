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
import type { LitigationArtifactKind } from "./litigationDomain";
import { resolveLitigationDocumentTemplate } from "./litigationDocumentTemplates";

type ArtifactRecord = Record<string, unknown>;

const OMITTED_FIELDS = new Set([
  "id",
  "matter_id",
  "user_id",
  "claim_id",
  "element_id",
  "fact_id",
  "source_span_id",
  "document_id",
  "primary_source_span_id",
  "parent_claim_id",
  "burden_party_id",
  "document_quote_start",
  "document_quote_end",
  "created_at",
  "updated_at",
  "decided_at",
  "metadata",
  "source_chunk_sha256",
  "quote_sha256",
]);

const BASE_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "matterId",
  "generatedAt",
  "statePolicy",
  "sourceIntegrity",
  "dependencyHash",
  "sources",
  "documentTemplate",
  "documentProfile",
]);

function record(value: unknown): ArtifactRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ArtifactRecord)
    : null;
}

function humanize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function scalar(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return null;
}

function itemTitle(value: ArtifactRecord, fallback: string) {
  for (const key of ["title", "statement", "name", "event_type"]) {
    const candidate = scalar(value[key]);
    if (candidate) return candidate;
  }
  return fallback;
}

function renderRecord(value: ArtifactRecord, fallback: string, depth = 0) {
  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: itemTitle(value, fallback), bold: true })],
      spacing: { before: depth === 0 ? 160 : 80, after: 80 },
    }),
  ];
  for (const [key, nested] of Object.entries(value)) {
    if (OMITTED_FIELDS.has(key)) continue;
    const text = scalar(nested);
    if (text) {
      if (
        text === itemTitle(value, fallback) &&
        ["title", "statement", "name"].includes(key)
      ) {
        continue;
      }
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${humanize(key)}: `, bold: true }),
            new TextRun(text),
          ],
          indent: { left: 240 * (depth + 1) },
          spacing: { after: 60 },
        }),
      );
      continue;
    }
    if (Array.isArray(nested) && depth < 2) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: humanize(key), bold: true })],
          indent: { left: 240 * (depth + 1) },
          spacing: { before: 80, after: 40 },
        }),
      );
      nested.forEach((entry, index) => {
        const nestedRecord = record(entry);
        if (nestedRecord) {
          children.push(
            ...renderRecord(
              nestedRecord,
              `${humanize(key)} ${index + 1}`,
              depth + 1,
            ),
          );
        } else {
          const nestedText = scalar(entry);
          if (nestedText) {
            children.push(
              new Paragraph({
                text: nestedText,
                bullet: { level: Math.min(depth, 2) },
              }),
            );
          }
        }
      });
    }
  }
  return children;
}

function renderSection(
  key: string,
  value: unknown,
  sectionLabels: Record<string, string>,
) {
  const label = sectionLabels[key] ?? humanize(key);
  const children: Paragraph[] = [
    new Paragraph({ text: label, heading: HeadingLevel.HEADING_1 }),
  ];
  if (Array.isArray(value)) {
    if (value.length === 0) {
      children.push(new Paragraph({ text: "No confirmed items." }));
      return children;
    }
    value.forEach((entry, index) => {
      const nestedRecord = record(entry);
      if (nestedRecord) {
        children.push(
          ...renderRecord(nestedRecord, `${humanize(key)} ${index + 1}`),
        );
      } else {
        const text = scalar(entry);
        if (text) children.push(new Paragraph({ text, bullet: { level: 0 } }));
      }
    });
    return children;
  }
  const nestedRecord = record(value);
  if (nestedRecord)
    return [...children, ...renderRecord(nestedRecord, humanize(key))];
  const text = scalar(value);
  children.push(new Paragraph({ text: text ?? "No confirmed content." }));
  return children;
}

function renderSources(value: unknown, chinese: boolean) {
  const sources = Array.isArray(value) ? value : [];
  const children: Paragraph[] = [
    new Paragraph({
      text: chinese ? "来源索引" : "Source references",
      heading: HeadingLevel.HEADING_1,
    }),
  ];
  if (sources.length === 0) {
    children.push(new Paragraph({ text: "No source references." }));
    return children;
  }
  sources.forEach((entry, index) => {
    const source = record(entry) ?? {};
    const documentName = scalar(source.documentName) ?? `Source ${index + 1}`;
    const page = scalar(source.page);
    const section = scalar(source.section);
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: [documentName, page ? `p. ${page}` : null, section]
              .filter(Boolean)
              .join(" · "),
            bold: true,
          }),
        ],
        spacing: { before: 140, after: 60 },
      }),
    );
    const quote = scalar(source.quote);
    if (quote) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `“${quote}”`, italics: true })],
          indent: { left: 360, right: 360 },
          spacing: { after: 80 },
        }),
      );
    }
  });
  return children;
}

export function renderLitigationArtifactPlainText(content: ArtifactRecord) {
  const lines: string[] = [];
  const append = (label: string, value: unknown, depth = 0) => {
    if (value === null || value === undefined || value === "") return;
    const prefix = "  ".repeat(depth);
    const text = scalar(value);
    if (text) {
      lines.push(`${prefix}${label}: ${text}`);
      return;
    }
    if (Array.isArray(value)) {
      lines.push(`${prefix}${label}`);
      value.forEach((item, index) => append(`${index + 1}`, item, depth + 1));
      return;
    }
    const nested = record(value);
    if (!nested) return;
    lines.push(`${prefix}${label}`);
    for (const [key, item] of Object.entries(nested)) {
      if (!OMITTED_FIELDS.has(key)) append(humanize(key), item, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(content)) {
    if (!BASE_FIELDS.has(key)) append(humanize(key), value);
  }
  append("Source references", content.sources);
  return lines.join("\n").slice(0, 2_000_000);
}

export async function buildLitigationArtifactDocx(args: {
  title: string;
  kind: LitigationArtifactKind;
  matterId: string;
  version: number;
  contentHash: string;
  exportedAt: string;
  content: ArtifactRecord;
}) {
  const binding = record(args.content.documentTemplate);
  const template = resolveLitigationDocumentTemplate(
    String(binding?.id ?? ""),
    Number(binding?.version ?? 0),
  );
  if (!template || binding?.templateHash !== template.templateHash) {
    throw new Error("Litigation document template binding is invalid.");
  }
  const chinese = template.locale === "zh-CN";
  const body: Paragraph[] = [
    new Paragraph({ text: args.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Version ${args.version} · Confirmed-state work product`,
          bold: true,
        }),
      ],
      spacing: { after: 100 },
    }),
    new Paragraph({
      children: [
        new TextRun(
          `Exported ${args.exportedAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}`,
        ),
      ],
      spacing: { after: 40 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Content hash: ", bold: true, size: 18 }),
        new TextRun({ text: args.contentHash, font: "Courier New", size: 18 }),
      ],
      spacing: { after: 220 },
    }),
  ];

  for (const [key, value] of Object.entries(args.content)) {
    if (!BASE_FIELDS.has(key))
      body.push(...renderSection(key, value, template.sectionLabels));
  }
  body.push(...renderSources(args.content.sources, chinese));
  body.push(
    new Paragraph({
      text: chinese
        ? "本工作底稿仅使用已确认的案件状态生成。对外提交或专业依赖前必须由律师复核。"
        : "Generated from confirmed matter state. Human review is required before professional reliance or external submission.",
      spacing: { before: 300 },
    }),
  );

  const document = new Document({
    creator: "Aletheia",
    title: args.title,
    subject: humanize(args.kind),
    description: `Matter ${args.matterId}; version ${args.version}; approval-bound local export.`,
    styles: {
      default: {
        document: {
          run: { font: template.fontFamily, size: 22, color: "202124" },
          paragraph: { spacing: { line: 264, after: 120 } },
        },
      },
      paragraphStyles: [
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: {
            font: template.fontFamily,
            size: 48,
            bold: true,
            color: "111827",
          },
          paragraph: { spacing: { before: 0, after: 120 } },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: {
            font: template.fontFamily,
            size: 32,
            bold: true,
            color: template.headingColor,
          },
          paragraph: {
            spacing: { before: 320, after: 160 },
            keepNext: true,
          },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: {
            font: template.fontFamily,
            size: 26,
            bold: true,
            color: template.headingColor,
          },
          paragraph: {
            spacing: { before: 240, after: 120 },
            keepNext: true,
          },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: "Aletheia · Local litigation workspace",
                    bold: true,
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                text: "Confidential · Approval-bound local export",
                alignment: AlignmentType.CENTER,
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
