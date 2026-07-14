import JSZip from "jszip";

import {
  TabularRepository,
  type TabularExportData,
} from "./repositories/tabular";

const ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");
const sensitiveToken =
  /(?:bearer\s+)[a-z0-9._~+\/-]+|\b(?:sk|key)-[a-z0-9_-]{8,}\b/gi;
const localPath = /(?:\/[Uu]sers\/|\/home\/|[A-Za-z]:\\)[^\s"']+/g;

function transportText(value: string) {
  return value
    .replace(sensitiveToken, "[redacted]")
    .replace(localPath, "[redacted-path]");
}

/** Prefix values spreadsheets may interpret as formulas, including whitespace-prefixed forms. */
export function protectSpreadsheetFormula(value: string) {
  const safe = transportText(value);
  return /^[\t\r\n ]*[=+\-@]/.test(safe) ? `'${safe}` : safe;
}

function displayValue(value: string | null | undefined) {
  if (!value) return "";
  return protectSpreadsheetFormula(value);
}

function matrix(data: TabularExportData) {
  const header = [
    "Document ID",
    "Document Title",
    ...data.columns.map((column) => protectSpreadsheetFormula(column.title)),
  ];
  const rows = data.rows.map((row) => {
    const cellsByColumn = new Map(
      row.cells.map((cell) => [cell.columnId, cell]),
    );
    return [
      row.documentId,
      protectSpreadsheetFormula(row.documentTitle),
      ...data.columns.map((column) => {
        const cell = cellsByColumn.get(column.id);
        return cell?.status === "complete"
          ? displayValue(cell.content?.summary)
          : "";
      }),
    ];
  });
  return [header, ...rows];
}

function csvField(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export function renderTabularCsv(data: TabularExportData) {
  return `${matrix(data)
    .map((row) => row.map(csvField).join(","))
    .join("\r\n")}\r\n`;
}

function xmlText(value: string) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
      ? character
      : "";
  }).join("");
}

function xml(value: string) {
  return xmlText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index: number) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  }
  return name;
}

function worksheetXml(rows: string[][]) {
  const lastCell = `${columnName(Math.max(0, rows[0].length - 1))}${Math.max(1, rows.length)}`;
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
          return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCell}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
}

function addFile(zip: JSZip, name: string, content: string) {
  zip.file(name, content, { date: ZIP_DATE, createFolders: false });
}

/** Build a deterministic, formula-safe XLSX from persisted review state. */
export async function renderTabularXlsx(
  data: TabularExportData,
): Promise<Buffer> {
  const zip = new JSZip();
  addFile(
    zip,
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
  );
  addFile(
    zip,
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  );
  addFile(
    zip,
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Vera</dc:creator><cp:lastModifiedBy>Vera</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${xml(data.review.createdAt)}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${xml(data.review.updatedAt)}</dcterms:modified>
</cp:coreProperties>`,
  );
  addFile(
    zip,
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Vera</Application></Properties>`,
  );
  addFile(
    zip,
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Review" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  addFile(
    zip,
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  addFile(
    zip,
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
  );
  addFile(zip, "xl/worksheets/sheet1.xml", worksheetXml(matrix(data)));
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "DOS",
  });
}

export class TabularExporter {
  constructor(private readonly repository: TabularRepository) {}

  csv(reviewId: string) {
    return renderTabularCsv(this.repository.getExportData(reviewId));
  }

  xlsx(reviewId: string) {
    return renderTabularXlsx(this.repository.getExportData(reviewId));
  }
}
