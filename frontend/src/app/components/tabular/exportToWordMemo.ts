"use client";

import {
    AlignmentType,
    BorderStyle,
    Document as WordDocument,
    HeadingLevel,
    Packer,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
} from "docx";

import type { ColumnConfig, Document, TabularCell } from "../shared/types";
import { preprocessCitations, type ParsedCitation } from "./citation-utils";
import { MAX_PROJECT_DOCUMENT_BYTES } from "./exportToExcel";

export type TabularReviewWordMemoParams = {
    reviewTitle: string;
    matterName?: string;
    columns: ColumnConfig[];
    documents: Document[];
    cells: TabularCell[];
};

export type TabularReviewWordMemoExport = {
    blob: Blob;
    filename: string;
};

type MemoCitation = {
    reference: string;
    sourceDocument: string;
    reviewArea: string;
    section: "Finding" | "Analysis";
    locator: string;
    quote: string;
};

const BODY_SIZE = 21;
const PAGE_CONTENT_WIDTH = 9360;
const FONT = {
    ascii: "Arial",
    hAnsi: "Arial",
    eastAsia: "PingFang SC",
    cs: "Arial",
    hint: "eastAsia",
} as const;
const cellBorders = {
    top: { style: BorderStyle.SINGLE, size: 1, color: "D9DDE3" },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: "D9DDE3" },
    left: { style: BorderStyle.SINGLE, size: 1, color: "D9DDE3" },
    right: { style: BorderStyle.SINGLE, size: 1, color: "D9DDE3" },
};

function sanitizeFilename(name: string): string {
    return (
        name
            .replace(/[\\/:*?"<>|]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 72) || "Tabular Review"
    );
}

function plainText(value: string | undefined): string {
    if (!value) return "";
    return preprocessCitations(value)
        .processed.replace(/§\d+§/g, "")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim();
}

function locator(citation: ParsedCitation): string {
    if (citation.sheet && citation.cell) return `${citation.sheet}!${citation.cell}`;
    if (citation.cell) return citation.cell;
    if (citation.sheet) return citation.sheet;
    return citation.page ? `Page ${citation.page}` : "Source passage";
}

function referenceFor(
    documentIndex: number,
    columnIndex: number,
    section: "F" | "A",
    citationIndex: number,
): string {
    return `C-${String(documentIndex + 1).padStart(2, "0")}-${String(columnIndex + 1).padStart(2, "0")}-${section}-${String(citationIndex + 1).padStart(2, "0")}`;
}

function bodyParagraph(text: string, options?: { italic?: boolean }) {
    return new Paragraph({
        spacing: { after: 120, line: 276 },
        children: [
            new TextRun({
                text,
                font: FONT,
                size: BODY_SIZE,
                italics: options?.italic,
                color: "20242C",
            }),
        ],
    });
}

function tableCell(text: string, width: number, header = false): TableCell {
    return new TableCell({
        width: { size: width, type: WidthType.DXA },
        borders: cellBorders,
        shading: header ? { fill: "F2F4F7" } : undefined,
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [
            new Paragraph({
                spacing: { after: 0, line: 252 },
                children: [
                    new TextRun({
                        text,
                        font: FONT,
                        size: 19,
                        bold: header,
                        color: "20242C",
                    }),
                ],
            }),
        ],
    });
}

/**
 * Builds an editable, deterministic memo from reviewed tabular results.
 * References are repeated in a source appendix so exported conclusions remain
 * traceable to the source document, locator, and exact excerpt.
 */
export async function buildTabularReviewWordMemo(
    params: TabularReviewWordMemoParams,
): Promise<TabularReviewWordMemoExport> {
    const { reviewTitle, matterName, columns, documents, cells } = params;
    const sortedColumns = [...columns].sort((a, b) => a.index - b.index);
    const cellMap = new Map(
        cells.map((cell) => [`${cell.document_id}:${cell.column_index}`, cell]),
    );
    const citations: MemoCitation[] = [];
    const findings: Array<{
        sourceDocument: string;
        reviewArea: string;
        finding: string;
        analysis: string;
        status: string;
    }> = [];

    let completedFindings = 0;
    let flaggedFindings = 0;
    for (const [documentIndex, sourceDocument] of documents.entries()) {
        for (const [columnIndex, column] of sortedColumns.entries()) {
            const cell = cellMap.get(`${sourceDocument.id}:${column.index}`);
            if (!cell || cell.status !== "done" || !cell.content?.summary) continue;

            completedFindings += 1;
            if (cell.content.flag === "red" || cell.content.flag === "yellow") {
                flaggedFindings += 1;
            }

            const findingRefs = preprocessCitations(cell.content.summary).citations.map(
                (citation, citationIndex) => {
                    const reference = referenceFor(documentIndex, columnIndex, "F", citationIndex);
                    citations.push({
                        reference,
                        sourceDocument: sourceDocument.filename,
                        reviewArea: column.name,
                        section: "Finding",
                        locator: locator(citation),
                        quote: citation.quote,
                    });
                    return `[${reference}]`;
                },
            );
            const analysisRefs = preprocessCitations(cell.content.reasoning ?? "").citations.map(
                (citation, citationIndex) => {
                    const reference = referenceFor(documentIndex, columnIndex, "A", citationIndex);
                    citations.push({
                        reference,
                        sourceDocument: sourceDocument.filename,
                        reviewArea: column.name,
                        section: "Analysis",
                        locator: locator(citation),
                        quote: citation.quote,
                    });
                    return `[${reference}]`;
                },
            );
            const summary = [plainText(cell.content.summary), ...findingRefs]
                .filter(Boolean)
                .join(" ");
            const analysis = plainText(cell.content.reasoning);
            const status =
                cell.content.flag === "red"
                    ? "High attention"
                    : cell.content.flag === "yellow"
                      ? "Review"
                      : cell.content.flag === "green"
                        ? "No issue noted"
                        : "Not rated";

            findings.push({
                sourceDocument: sourceDocument.filename,
                reviewArea: column.name,
                finding: summary,
                analysis:
                    analysis && analysisRefs.length
                        ? `${analysis} ${analysisRefs.join(" ")}`
                        : analysis,
                status,
            });
        }
    }

    const children: Array<Paragraph | Table> = [
        new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.LEFT,
            spacing: { after: 80 },
            children: [
                new TextRun({
                    text: `${reviewTitle} — Review Memo`,
                    font: FONT,
                    size: 46,
                    bold: true,
                    color: "141821",
                }),
            ],
        }),
        new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { after: 320 },
            children: [
                new TextRun({
                    text: "DRAFT — LAWYER REVIEW REQUIRED",
                    font: FONT,
                    size: 18,
                    bold: true,
                    color: "7A4B00",
                }),
            ],
        }),
        new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "Executive summary", font: FONT, bold: true })],
        }),
        bodyParagraph(
            `${matterName ? `Matter: ${matterName}. ` : ""}${documents.length} source document${documents.length === 1 ? "" : "s"} reviewed across ${sortedColumns.length} review area${sortedColumns.length === 1 ? "" : "s"}. ${completedFindings} completed finding${completedFindings === 1 ? "" : "s"}; ${flaggedFindings} marked for attention.`,
        ),
        bodyParagraph(
            "This memo is generated from the current Tabular Review results. Verify each material conclusion against the cited source excerpt before relying on or sharing it.",
            { italic: true },
        ),
        new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "Findings", font: FONT, bold: true })],
        }),
        ...(findings.length > 0
            ? findings.flatMap((finding, index) => [
                  new Paragraph({
                      heading: HeadingLevel.HEADING_2,
                      spacing: { before: index === 0 ? 100 : 200, after: 80 },
                      children: [
                          new TextRun({
                              text: finding.reviewArea,
                              font: FONT,
                              bold: true,
                          }),
                      ],
                  }),
                  new Paragraph({
                      spacing: { after: 80 },
                      children: [
                          new TextRun({
                              text: `${finding.sourceDocument} · ${finding.status}`,
                              font: FONT,
                              size: 18,
                              color: "667085",
                          }),
                      ],
                  }),
                  bodyParagraph(finding.finding),
                  ...(finding.analysis
                      ? [bodyParagraph(`Analysis: ${finding.analysis}`)]
                      : []),
              ])
            : [bodyParagraph("No completed findings are available yet.")]),
        new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 240 },
            children: [new TextRun({ text: "Source notes", font: FONT, bold: true })],
        }),
    ];

    if (citations.length === 0) {
        children.push(
            bodyParagraph(
                "No source citations were present in the completed findings. Add or verify citations in Tabular Review before final use.",
                { italic: true },
            ),
        );
    } else {
        children.push(
            new Table({
                width: { size: PAGE_CONTENT_WIDTH, type: WidthType.DXA },
                indent: { size: 120, type: WidthType.DXA },
                columnWidths: [1200, 2300, 1300, 4560],
                rows: [
                    new TableRow({
                        tableHeader: true,
                        children: [
                            tableCell("Reference", 1200, true),
                            tableCell("Source", 2300, true),
                            tableCell("Locator", 1300, true),
                            tableCell("Source excerpt", 4560, true),
                        ],
                    }),
                    ...citations.map(
                        (citation) =>
                            new TableRow({
                                children: [
                                    tableCell(citation.reference, 1200),
                                    tableCell(
                                        `${citation.sourceDocument}\n${citation.reviewArea} · ${citation.section}`,
                                        2300,
                                    ),
                                    tableCell(citation.locator, 1300),
                                    tableCell(citation.quote, 4560),
                                ],
                            }),
                    ),
                ],
            }),
        );
    }

    const wordDocument = new WordDocument({
        styles: {
            default: {
                document: {
                    run: { font: FONT, size: 22, color: "20242C" },
                    paragraph: { spacing: { after: 120, line: 264 } },
                },
            },
            paragraphStyles: [
                {
                    id: "Heading1",
                    name: "Heading 1",
                    basedOn: "Normal",
                    next: "Normal",
                    quickFormat: true,
                    run: { font: FONT, size: 32, bold: true, color: "2E74B5" },
                    paragraph: { spacing: { before: 240, after: 120 } },
                },
                {
                    id: "Heading2",
                    name: "Heading 2",
                    basedOn: "Normal",
                    next: "Normal",
                    quickFormat: true,
                    run: { font: FONT, size: 26, bold: true, color: "2E74B5" },
                    paragraph: { spacing: { before: 200, after: 100 } },
                },
            ],
        },
        sections: [
            {
                properties: {
                    page: {
                        size: { width: 12240, height: 15840 },
                        margin: {
                            top: 1440,
                            right: 1440,
                            bottom: 1440,
                            left: 1440,
                            header: 708,
                            footer: 708,
                        },
                    },
                },
                children,
            },
        ],
    });
    const blob = await Packer.toBlob(wordDocument);
    return {
        blob,
        filename: `${sanitizeFilename(reviewTitle)} - Review Memo.docx`,
    };
}

export function isTabularReviewWordMemoWithinUploadLimit(blob: Blob): boolean {
    return blob.size <= MAX_PROJECT_DOCUMENT_BYTES;
}
