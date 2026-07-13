import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import JSZip from "jszip";

type LitigationFixture = {
  matterId: string;
  matterUrl: string;
  matterTitle: string;
  backendPort: number;
  dataDir: string;
};

function xmlText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function reviseDraftDocx(
  source: Buffer,
  revision: string,
  tracked = false,
) {
  const archive = await JSZip.loadAsync(source);
  const documentPart = archive.file("word/document.xml");
  if (!documentPart)
    throw new Error("Downloaded DOCX has no word/document.xml");
  const documentXml = await documentPart.async("string");
  const bookmarkIndex = documentXml.indexOf(
    'w:name="vera_section_material-facts"',
  );
  if (bookmarkIndex < 0) {
    throw new Error("Downloaded DOCX has no material-facts binding bookmark");
  }
  const headingEnd = documentXml.indexOf("</w:p>", bookmarkIndex);
  if (headingEnd < 0) throw new Error("Bound section heading is malformed");
  const textRun = `<w:r><w:t xml:space="preserve">${xmlText(revision)}</w:t></w:r>`;
  const insertedParagraph = tracked
    ? `<w:p><w:ins w:id="900" w:author="Counsel" w:date="2026-07-12T00:00:00Z">${textRun}</w:ins></w:p>`
    : `<w:p>${textRun}</w:p>`;
  const insertionPoint = headingEnd + "</w:p>".length;
  archive.file(
    "word/document.xml",
    `${documentXml.slice(0, insertionPoint)}${insertedParagraph}${documentXml.slice(insertionPoint)}`,
  );
  return archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function fixture(projectName: string): LitigationFixture {
  const state = JSON.parse(
    readFileSync(path.join(process.cwd(), ".next-ui-smoke-state.json"), "utf8"),
  ) as {
    projects: Record<string, { litigation?: LitigationFixture }>;
    backendPort: number;
    dataDir: string;
  };
  const litigation = state.projects[projectName]?.litigation;
  if (!litigation)
    throw new Error(`Missing litigation fixture for ${projectName}`);
  return {
    ...litigation,
    backendPort: state.backendPort,
    dataDir: state.dataDir,
  };
}

function citationPdfFixture() {
  const labels = [
    "CITATION PAGE ONE",
    "RECORDED CITATION PAGE TWO",
    "CITATION PAGE THREE",
  ];
  const fontId = 9;
  const objects = new Map<number, string>([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Count 3 /Kids [3 0 R 5 0 R 7 0 R] >>"],
    [fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  ]);
  labels.forEach((label, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const stream = `BT /F1 24 Tf 72 700 Td (${label}) Tj ET`;
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    objects.set(
      contentId,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  });
  let body = "%PDF-1.4\n% local citation fixture\n";
  const offsets = [0];
  for (let id = 1; id <= fontId; id += 1) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= fontId; id += 1) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

async function alignAuditSection(page: Page, section: Locator) {
  await section.scrollIntoViewIfNeeded();
  await section.evaluate((element) => {
    let parent = element.parentElement;
    while (parent) {
      if (/(auto|scroll)/.test(window.getComputedStyle(parent).overflowY)) {
        const offset =
          element.getBoundingClientRect().top -
          parent.getBoundingClientRect().top;
        parent.scrollTop += offset - 12;
        return;
      }
      parent = parent.parentElement;
    }
  });
  await page.waitForTimeout(120);
}

async function assertAuditVisualIntegrity(page: Page) {
  const audit = await page.evaluate(() => {
    const paintedRect = (element: HTMLElement) => {
      const source = element.getBoundingClientRect();
      let left = Math.max(0, source.left);
      let right = Math.min(window.innerWidth, source.right);
      let top = Math.max(0, source.top);
      let bottom = Math.min(window.innerHeight, source.bottom);
      let parent = element.parentElement;
      while (parent) {
        const style = window.getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, rect.left);
          right = Math.min(right, rect.right);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
        }
        parent = parent.parentElement;
      }
      return {
        left,
        right,
        top,
        bottom,
        width: right - left,
        height: bottom - top,
      };
    };
    const visible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      const rect = paintedRect(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.bottom <= 0 ||
        rect.top >= window.innerHeight
      ) {
        return false;
      }
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return Boolean(hit && (hit === element || element.contains(hit)));
    };
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
      ),
    ).filter(visible);
    const clipped = controls
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > window.innerWidth + 1;
      })
      .map(
        (element) =>
          element.getAttribute("aria-label") ||
          element.textContent?.trim() ||
          element.tagName,
      );
    const intersections: string[] = [];
    for (let index = 0; index < controls.length; index += 1) {
      const left = controls[index];
      const leftRect = paintedRect(left);
      for (
        let candidate = index + 1;
        candidate < controls.length;
        candidate += 1
      ) {
        const right = controls[candidate];
        if (left.contains(right) || right.contains(left)) continue;
        const rightRect = paintedRect(right);
        const width =
          Math.min(leftRect.right, rightRect.right) -
          Math.max(leftRect.left, rightRect.left);
        const height =
          Math.min(leftRect.bottom, rightRect.bottom) -
          Math.max(leftRect.top, rightRect.top);
        if (width > 1 && height > 1) {
          intersections.push(
            `${left.tagName}:${right.tagName}:${Math.round(width)}x${Math.round(height)}`,
          );
        }
      }
    }
    const header = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".aletheia-shell > div > header, .aletheia-mobile-header",
      ),
    ).find((element) => window.getComputedStyle(element).display !== "none");
    const scroller = document.querySelector<HTMLElement>(
      ".aletheia-shell > div > main.overflow-y-auto",
    );
    return {
      documentOverflow: Math.max(
        0,
        document.documentElement.scrollWidth - window.innerWidth,
      ),
      headerOverlap:
        header && scroller
          ? Math.max(
              0,
              header.getBoundingClientRect().bottom -
                scroller.getBoundingClientRect().top,
            )
          : null,
      clipped,
      intersections,
    };
  });
  expect(audit.documentOverflow).toBeLessThanOrEqual(1);
  expect(audit.headerOverlap).not.toBeNull();
  expect(audit.headerOverlap!).toBeLessThanOrEqual(1);
  expect(audit.clipped).toEqual([]);
  expect(audit.intersections).toEqual([]);
  return audit;
}

async function assertComparisonViewerVisualIntegrity(page: Page) {
  const viewer = page.getByTestId("original-evidence-viewer");
  const result = await viewer.evaluate((element) => {
    const viewerRect = element.getBoundingClientRect();
    const canvas = element.querySelector("canvas")!;
    const canvasRect = canvas.getBoundingClientRect();
    const canvasStageRect = canvas.parentElement!.getBoundingClientRect();
    const inspector = element.querySelector<HTMLElement>(
      "[data-testid='original-comparison-inspector']",
    )!;
    const inspectorRect = inspector.getBoundingClientRect();
    const footer = element.querySelector<HTMLElement>("footer")!;
    const footerRect = footer.getBoundingClientRect();
    const submit = Array.from(inspector.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Record text comparison",
    );
    const submitRect = submit?.getBoundingClientRect();
    const submitHit = submitRect
      ? document.elementFromPoint(
          submitRect.left + submitRect.width / 2,
          submitRect.top + submitRect.height / 2,
        )
      : null;
    const controls = Array.from(
      element.querySelectorAll<HTMLElement>(
        "button:not([disabled]), textarea:not([disabled])",
      ),
    ).filter((control) => {
      const rect = control.getBoundingClientRect();
      const style = window.getComputedStyle(control);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left + rect.width / 2 >= 0 &&
        rect.left + rect.width / 2 <= window.innerWidth &&
        rect.top + rect.height / 2 >= 0 &&
        rect.top + rect.height / 2 <= window.innerHeight &&
        (() => {
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return hit === control || Boolean(hit && control.contains(hit));
        })()
      );
    });
    const collisions: string[] = [];
    controls.forEach((left, index) => {
      const leftRect = left.getBoundingClientRect();
      controls.slice(index + 1).forEach((right) => {
        if (left.contains(right) || right.contains(left)) return;
        const rightRect = right.getBoundingClientRect();
        const width =
          Math.min(leftRect.right, rightRect.right) -
          Math.max(leftRect.left, rightRect.left);
        const height =
          Math.min(leftRect.bottom, rightRect.bottom) -
          Math.max(leftRect.top, rightRect.top);
        if (width > 1 && height > 1) {
          collisions.push(`${left.tagName}:${right.tagName}`);
        }
      });
    });
    const canvasInspectorOverlap = {
      width:
        Math.min(canvasStageRect.right, inspectorRect.right) -
        Math.max(canvasStageRect.left, inspectorRect.left),
      height:
        Math.min(canvasStageRect.bottom, inspectorRect.bottom) -
        Math.max(canvasStageRect.top, inspectorRect.top),
    };
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentOverflow:
        document.documentElement.scrollWidth - window.innerWidth,
      viewer: {
        left: viewerRect.left,
        right: viewerRect.right,
        top: viewerRect.top,
        bottom: viewerRect.bottom,
        overflow: element.scrollWidth - element.clientWidth,
      },
      canvas: {
        width: canvasRect.width,
        height: canvasRect.height,
      },
      inspectorOverflow: inspector.scrollWidth - inspector.clientWidth,
      inspectorScrollRange: inspector.scrollHeight - inspector.clientHeight,
      inspectorOverflowY: window.getComputedStyle(inspector).overflowY,
      inspectorFooterOverlap: inspectorRect.bottom - footerRect.top,
      submit: submitRect
        ? {
            left: submitRect.left,
            right: submitRect.right,
            top: submitRect.top,
            bottom: submitRect.bottom,
            hit:
              submitHit === submit ||
              Boolean(submitHit && submit?.contains(submitHit)),
          }
        : null,
      canvasInspectorOverlap,
      collisions,
    };
  });
  expect(result.documentOverflow).toBeLessThanOrEqual(1);
  expect(result.viewer.left).toBeGreaterThanOrEqual(-1);
  expect(result.viewer.right).toBeLessThanOrEqual(result.viewportWidth + 1);
  expect(result.viewer.top).toBeGreaterThanOrEqual(-1);
  expect(result.viewer.bottom).toBeLessThanOrEqual(result.viewportHeight + 1);
  expect(result.viewer.overflow).toBeLessThanOrEqual(1);
  expect(result.inspectorOverflow).toBeLessThanOrEqual(1);
  expect(result.inspectorFooterOverlap).toBeLessThanOrEqual(1);
  expect(result.submit).not.toBeNull();
  expect(result.submit!.left).toBeGreaterThanOrEqual(-1);
  expect(result.submit!.right).toBeLessThanOrEqual(result.viewportWidth + 1);
  expect(result.submit!.top).toBeGreaterThanOrEqual(-1);
  expect(result.submit!.bottom).toBeLessThanOrEqual(result.viewportHeight + 1);
  expect(result.submit!.hit).toBe(true);
  if (result.viewportWidth === 393 && result.viewportHeight === 852) {
    expect(result.inspectorOverflowY).toBe("auto");
    expect(result.inspectorScrollRange).toBeGreaterThan(0);
  }
  expect(result.canvas.width).toBeGreaterThan(100);
  expect(result.canvas.height).toBeGreaterThan(100);
  expect(
    result.canvasInspectorOverlap.width > 1 &&
      result.canvasInspectorOverlap.height > 1,
  ).toBe(false);
  expect(result.collisions).toEqual([]);
}

async function assertAnchorReceiptGeometry(page: Page, anchor: Locator) {
  const geometry = await anchor.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const descendants = Array.from(
      element.querySelectorAll<HTMLElement>("button, dd, [class*='font-mono']"),
    );
    return {
      viewportWidth: window.innerWidth,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      scrollOverflow: element.scrollWidth - element.clientWidth,
      escapedDescendants: descendants
        .filter((item) => {
          const itemRect = item.getBoundingClientRect();
          return (
            itemRect.left < rect.left - 1 || itemRect.right > rect.right + 1
          );
        })
        .map(
          (item) =>
            item.getAttribute("aria-label") || item.textContent?.trim() || "",
        ),
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.scrollOverflow).toBeLessThanOrEqual(1);
  expect(geometry.escapedDescendants).toEqual([]);
}

const semanticFixtureEnabled =
  process.env.ALETHEIA_FINDING_ENTAILMENT_FIXTURE === "1";
const semanticRuntimePort = Number(
  process.env.ALETHEIA_FINDING_ENTAILMENT_FIXTURE_PORT ?? 3413,
);
const semanticModelId = "finding-entailment-fixture";
const semanticProviderModel = "fixture-finding-entailment";
let semanticRuntime: Server | null = null;
let semanticFixtureFailure = false;

const semanticBenchmarkOutputs = {
  calibration: {
    summary: "收据记载了交付事实。",
    summaryCitations: [
      {
        sourceId: "calibration-source-v1",
        quote: "2026年7月10日，甲方向乙方交付了编号为A-17的收据。",
      },
    ],
    findings: [
      {
        statement: "甲方向乙方交付了编号为A-17的收据。",
        citations: [
          {
            sourceId: "calibration-source-v1",
            quote: "2026年7月10日，甲方向乙方交付了编号为A-17的收据。",
          },
        ],
        confidence: "high",
        uncertainty: null,
      },
    ],
    questionsForCounsel: [],
  },
  single_exact_quote: {
    summary: "收据显示甲方向乙方支付5000元。",
    summaryCitations: [
      {
        sourceId: "receipt-v1",
        quote: "2026年3月2日，甲方向乙方支付货款人民币5000元，乙方出具收据。",
      },
    ],
    findings: [
      {
        statement: "5000元付款有收据支持。",
        citations: [
          {
            sourceId: "receipt-v1",
            quote:
              "2026年3月2日，甲方向乙方支付货款人民币5000元，乙方出具收据。",
          },
        ],
        confidence: "high",
        uncertainty: null,
      },
    ],
    questionsForCounsel: [],
  },
  conflicting_sources: {
    summary: "台账与银行流水存在矛盾，尾款是否支付无法确定。",
    summaryCitations: [
      {
        sourceId: "ledger-v1",
        quote: "乙方台账记载：2026年4月8日收到甲方尾款人民币20000元。",
      },
      {
        sourceId: "bank-v1",
        quote:
          "银行流水显示：2026年4月8日甲方账户未向乙方账户发生人民币20000元转账。",
      },
    ],
    findings: [
      {
        statement: "现有来源存在矛盾，无法确定尾款状态。",
        citations: [
          {
            sourceId: "ledger-v1",
            quote: "乙方台账记载：2026年4月8日收到甲方尾款人民币20000元。",
          },
          {
            sourceId: "bank-v1",
            quote:
              "银行流水显示：2026年4月8日甲方账户未向乙方账户发生人民币20000元转账。",
          },
        ],
        confidence: "low",
        uncertainty: "台账与银行记录矛盾，需要核实。",
      },
    ],
    questionsForCounsel: ["是否有其他银行记录或付款凭证可供核实？"],
  },
  insufficient_evidence_abstention: {
    summary: "合同未载明实际交付日期或验收记录，无法确定设备是否交付。",
    summaryCitations: [
      {
        sourceId: "contract-v1",
        quote:
          "《设备采购合同》第五条仅约定乙方应交付设备，未载明实际交付日期或验收记录。",
      },
    ],
    findings: [
      {
        statement: "现有合同未载明实际交付，无法确定履行状态。",
        citations: [
          {
            sourceId: "contract-v1",
            quote:
              "《设备采购合同》第五条仅约定乙方应交付设备，未载明实际交付日期或验收记录。",
          },
        ],
        confidence: "low",
        uncertainty: "证据不足，无法确定设备交付状态。",
      },
    ],
    questionsForCounsel: ["是否存在设备交付单或验收记录？"],
  },
  relevant_source_selection: {
    summary: "乙方同意将付款期限延长至6月30日。",
    summaryCitations: [
      {
        sourceId: "wechat-v1",
        quote:
          "2026年5月28日乙方微信回复：同意将本案付款期限延长至2026年6月30日。",
      },
    ],
    findings: [
      {
        statement: "乙方明确同意延期至6月30日。",
        citations: [
          {
            sourceId: "wechat-v1",
            quote:
              "2026年5月28日乙方微信回复：同意将本案付款期限延长至2026年6月30日。",
          },
        ],
        confidence: "high",
        uncertainty: null,
      },
    ],
    questionsForCounsel: [],
  },
} as const;

function firstGroundedSource(prompt: string) {
  const jsonStart = prompt.indexOf("{");
  if (jsonStart < 0) throw new Error("Grounded fixture prompt has no JSON.");
  const snapshot = JSON.parse(prompt.slice(jsonStart)) as Record<
    string,
    unknown
  >;
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  const source = sources.find(
    (item): item is Record<string, unknown> =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).id === "string" &&
      typeof (item as Record<string, unknown>).quote === "string",
  );
  if (!source) throw new Error("Grounded fixture prompt has no cited source.");
  return { sourceId: String(source.id), quote: String(source.quote) };
}

function semanticFixtureOutput(prompt: string): unknown {
  if (prompt.includes("Assess whether each exact citation supports")) {
    if (semanticFixtureFailure) return "not strict json";
    const evidenceStart = prompt.indexOf("<UNTRUSTED_EVIDENCE_JSON>");
    const evidenceEnd = prompt.indexOf("</UNTRUSTED_EVIDENCE_JSON>");
    if (evidenceStart < 0 || evidenceEnd <= evidenceStart) {
      throw new Error("Semantic fixture prompt has no citations.");
    }
    const evidence = JSON.parse(
      prompt.slice(
        evidenceStart + "<UNTRUSTED_EVIDENCE_JSON>".length,
        evidenceEnd,
      ),
    ) as { citations?: Array<{ sourceId?: unknown }> };
    const citations = Array.isArray(evidence.citations)
      ? evidence.citations
      : [];
    if (
      citations.length === 0 ||
      citations.some((citation) => typeof citation.sourceId !== "string")
    ) {
      throw new Error("Semantic fixture prompt has invalid citations.");
    }
    return {
      citations: citations.map((citation) => ({
        sourceId: String(citation.sourceId),
        assessment: "partial",
        rationale:
          "The exact citation supports the stated payment timing but not every implication in the finding.",
      })),
      overallRationale:
        "The cited text provides bounded support, while the broader conclusion still requires counsel judgment.",
      uncertainty:
        "The citation does not independently establish every legal implication.",
    };
  }
  if (prompt.includes("calibration-source-v1")) {
    return semanticBenchmarkOutputs.calibration;
  }
  for (const caseId of [
    "single_exact_quote",
    "conflicting_sources",
    "insufficient_evidence_abstention",
    "relevant_source_selection",
  ] as const) {
    const marker = {
      single_exact_quote: "receipt-v1",
      conflicting_sources: "ledger-v1",
      insufficient_evidence_abstention: "contract-v1",
      relevant_source_selection: "wechat-v1",
    }[caseId];
    if (prompt.includes(marker)) return semanticBenchmarkOutputs[caseId];
  }
  const citation = firstGroundedSource(prompt);
  return {
    summary: "The confirmed record supports a bounded litigation finding.",
    summaryCitations: [citation],
    findings: [
      {
        statement:
          "The confirmed source provides evidence relevant to the disputed payment timing.",
        citations: [citation],
        confidence: "medium",
        uncertainty: "Counsel must assess the legal effect of the source.",
      },
    ],
    questionsForCounsel: [
      "What additional record is required to resolve the remaining legal effect?",
    ],
  };
}

const semanticRuntimeReady = semanticFixtureEnabled
  ? new Promise<void>((resolve, reject) => {
      semanticRuntime = createServer((request, response) => {
        if (
          request.method === "POST" &&
          request.url === "/__fixture/semantic-failure"
        ) {
          const chunks: Buffer[] = [];
          request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          request.on("end", () => {
            const body = JSON.parse(
              Buffer.concat(chunks).toString("utf8") || "{}",
            ) as { enabled?: boolean };
            semanticFixtureFailure = body.enabled === true;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ enabled: semanticFixtureFailure }));
          });
          return;
        }
        if (request.method === "GET" && request.url === "/v1/models") {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({ data: [{ id: semanticProviderModel }] }),
          );
          return;
        }
        if (
          request.method === "POST" &&
          request.url === "/v1/chat/completions"
        ) {
          const chunks: Buffer[] = [];
          request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          request.on("end", () => {
            try {
              const body = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              ) as { messages?: Array<{ content?: string }> };
              const prompt = (body.messages ?? [])
                .map((message) => message.content ?? "")
                .join("\n");
              const fixtureOutput = semanticFixtureOutput(prompt);
              const content =
                typeof fixtureOutput === "string"
                  ? fixtureOutput
                  : JSON.stringify(fixtureOutput);
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  choices: [{ message: { role: "assistant", content } }],
                  usage: { completion_tokens: 180, total_tokens: 520 },
                }),
              );
            } catch (error) {
              response.statusCode = 500;
              response.end(
                error instanceof Error ? error.message : String(error),
              );
            }
          });
          return;
        }
        response.statusCode = 404;
        response.end("Not found");
      });
      semanticRuntime.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          semanticRuntime = null;
          resolve();
          return;
        }
        reject(error);
      });
      semanticRuntime.listen(semanticRuntimePort, "127.0.0.1", resolve);
    })
  : Promise.resolve();

test.beforeAll(async () => {
  await semanticRuntimeReady;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!semanticRuntime) return resolve();
    semanticRuntime.close((error) => (error ? reject(error) : resolve()));
  });
  semanticRuntime = null;
});

test("counsel corrects a source-bound event and recalculates from immutable lineage", async ({
  page,
}, testInfo) => {
  const state = fixture(testInfo.project.name);
  const apiBase = `http://127.0.0.1:${state.backendPort}`;
  const matterWrite = await page.request.post(`${apiBase}/aletheia/matters`, {
    data: {
      title: `Event correction lifecycle ${testInfo.project.name}`,
      template: "civil_litigation",
      objective:
        "Verify immutable procedural-event correction and recalculation.",
      status: "in_progress",
    },
  });
  expect(matterWrite.status()).toBe(201);
  const lifecycleMatter = (await matterWrite.json()) as { id: string };
  const matterId = lifecycleMatter.id;
  const matterUrl = `/aletheia/matters/${matterId}/litigation`;
  const exactQuote =
    "A response shall be filed within ten calendar days after service.";
  const authorityPayload = {
    authorityType: "regulation",
    title: "Shanghai Civil Filing Procedure",
    issuer: "Shanghai Commercial Court",
    officialIdentifier: "SCC-PROC-2026-10",
    versionLabel: "2026 verified text",
    sourceReference: "Official court publication SCC-PROC-2026-10",
    content: `Article 10. ${exactQuote}`,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  };
  const authorityWrite = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/legal-authorities`,
    { data: authorityPayload },
  );
  expect(authorityWrite.status()).toBe(201);
  const authority = (await authorityWrite.json()) as { id: string };
  const authorityVerification = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/legal-authorities/${authority.id}/verify`,
    { data: { comment: "Compared against the official court publication." } },
  );
  expect(authorityVerification.ok()).toBe(true);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${matterUrl}?view=facts`);
  const originalSourceQuote =
    "Court receipt: complaint served on 10 July 2026 at 10:00.";
  const correctedSourceQuote =
    "Clerk correction: complaint served on 12 July 2026 at 10:00.";
  await page.getByTestId("matter-document-files-input").setInputFiles({
    name: "service-receipt.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(`${originalSourceQuote}\n${correctedSourceQuote}`),
  });
  await expect(page.getByText("1 indexed", { exact: true })).toBeVisible();

  await page.goto(`${matterUrl}?view=procedure`);
  await page.getByLabel("Procedural event type").selectOption("service");
  await page
    .getByLabel("Procedural event title")
    .fill("Verified service of complaint");
  await page
    .getByLabel("Procedural event date and time")
    .fill("2026-07-10T10:00");
  await page.getByLabel("Source record").selectOption({ index: 1 });
  await page.getByLabel("Exact source quote").fill(originalSourceQuote);
  const eventCreateResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(`/aletheia/matters/${matterId}/litigation/procedural-events`),
  );
  await page.getByRole("button", { name: "Add event" }).click();
  const proceduralEvent = (await (await eventCreateResponse).json()) as {
    id: string;
    event_lineage_hash: string;
    primary_source_span_id: string;
  };
  expect(proceduralEvent.primary_source_span_id).toBeTruthy();
  const originalEventRow = page.getByTestId(
    `procedural-event-${proceduralEvent.id}`,
  );
  await expect(originalEventRow).toContainText(
    proceduralEvent.event_lineage_hash,
  );
  await originalEventRow.getByRole("button", { name: "Confirm" }).click();
  await expect(originalEventRow).toContainText("Current confirmed v1");

  await expect(
    page.getByRole("heading", { name: "Verified deadline rules" }),
  ).toBeVisible();
  await expect(page.getByLabel("Counting basis")).toBeEnabled();
  await expect(page.getByLabel("Counting basis")).toHaveValue("calendar_days");

  await page.getByLabel("Rule name").fill("Response after service");
  await page.getByLabel("Rule trigger event type").selectOption("service");
  await page.getByLabel("Rule authority version").selectOption(authority.id);
  await page.getByLabel("Provision reference").fill("Article 10");
  await page.getByLabel("Day offset").fill("10");
  await page.getByLabel("Exact provision quote").fill(exactQuote);
  await page.getByLabel("Counting starts").selectOption("next_day");

  const createRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request
        .url()
        .endsWith(`/aletheia/matters/${matterId}/litigation/deadline-rules`),
  );
  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(`/aletheia/matters/${matterId}/litigation/deadline-rules`),
  );
  await page.getByRole("button", { name: "Create draft rule" }).click();
  const createRequest = await createRequestPromise;
  expect(createRequest.postDataJSON()).toEqual({
    name: "Response after service",
    triggerEventType: "service",
    authorityVersionId: authority.id,
    provisionReference: "Article 10",
    exactQuote,
    offsetDays: 10,
    countingBasis: "calendar_days",
    startPolicy: "next_day",
  });
  const createdRule = (await (await createResponsePromise).json()) as {
    id: string;
    rule_hash: string;
  };
  const ruleRow = page.getByTestId(`deadline-rule-${createdRule.id}`);
  await expect(ruleRow).toBeVisible();
  await expect(ruleRow).toContainText(createdRule.rule_hash);
  await expect(ruleRow).toContainText("2026-01-01 to open ended");
  await expect(ruleRow).toContainText(exactQuote);

  const verificationReason =
    "Counsel checked the exact quote, next-day start, and calendar-day offset.";
  await ruleRow
    .getByLabel("Verification reason for Response after service")
    .fill(verificationReason);
  const verifyRequestPromise = page.waitForRequest((request) =>
    request.url().endsWith(`/deadline-rules/${createdRule.id}/verify`),
  );
  await ruleRow.getByRole("button", { name: "Verify rule" }).click();
  expect((await verifyRequestPromise).postDataJSON()).toEqual({
    comment: verificationReason,
  });
  await expect(ruleRow).toContainText(`Verified: ${verificationReason}`);

  await ruleRow
    .getByLabel("Calculation event for Response after service")
    .selectOption(proceduralEvent.id);
  await ruleRow
    .getByLabel("Deadline title for Response after service")
    .fill("File response to complaint");
  const calculateRequestPromise = page.waitForRequest((request) =>
    request.url().endsWith(`/deadline-rules/${createdRule.id}/calculate`),
  );
  const calculateResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/deadline-rules/${createdRule.id}/calculate`),
  );
  await ruleRow.getByRole("button", { name: "Calculate proposal" }).click();
  expect((await calculateRequestPromise).postDataJSON()).toEqual({
    eventId: proceduralEvent.id,
    title: "File response to complaint",
  });
  const calculatedDeadline = (await (
    await calculateResponsePromise
  ).json()) as { id: string; calculation_hash: string };
  const deadlineRow = page.locator("article").filter({
    hasText: "File response to complaint",
  });
  await expect(deadlineRow).toContainText(
    "Due at local day end 2026-07-20 23:59:59 Asia/Shanghai.",
  );
  await expect(deadlineRow).toContainText("2026-07-10 · Asia/Shanghai");
  await expect(deadlineRow).toContainText("10 calendar days · next day");
  await expect(deadlineRow).toContainText(calculatedDeadline.calculation_hash);
  await expect(deadlineRow).toContainText("proposed");
  await deadlineRow.getByRole("button", { name: "Confirm" }).click();
  await deadlineRow.getByRole("button", { name: "Add to work queue" }).click();
  await expect(deadlineRow).toContainText("状态：待办");

  await originalEventRow.getByRole("button", { name: "Correct event" }).click();
  await expect(originalEventRow).toContainText(
    "Existing exact source retained: service-receipt.txt.",
  );
  await originalEventRow
    .getByLabel("Corrected event title")
    .fill("Service of complaint corrected by clerk receipt");
  await originalEventRow
    .getByLabel("Corrected event date and time")
    .fill("2026-07-12T10:00");
  const correctionReason =
    "The clerk-issued correction records service two days later than the initial receipt.";
  await originalEventRow.getByLabel("Correction reason").fill(correctionReason);
  const correctionRequest = page.waitForRequest((request) =>
    request
      .url()
      .endsWith(`/procedural-events/${proceduralEvent.id}/corrections`),
  );
  const correctionResponse = page.waitForResponse((response) =>
    response
      .url()
      .endsWith(`/procedural-events/${proceduralEvent.id}/corrections`),
  );
  await originalEventRow
    .getByRole("button", { name: "Record correction" })
    .click();
  expect((await correctionRequest).postDataJSON()).toEqual({
    title: "Service of complaint corrected by clerk receipt",
    occurredAt: "2026-07-12T02:00:00.000Z",
    reason: correctionReason,
  });
  const correctionWrite = await correctionResponse;
  expect(correctionWrite.status()).toBe(201);
  const correction = (await correctionWrite.json()) as {
    correctionId: string;
    correctionHash: string;
    originalEventId: string;
    replacement: {
      id: string;
      title: string;
      occurred_at: string;
      event_lineage_hash: string;
    };
    invalidatedDeadlines: number;
    invalidatedTasks: number;
  };
  expect(correction.originalEventId).toBe(proceduralEvent.id);
  expect(correction.invalidatedDeadlines).toBe(1);
  expect(correction.invalidatedTasks).toBe(1);
  await expect(page.getByTestId("event-correction-result")).toContainText(
    "1 deadline marked stale · 1 task invalidated",
  );
  await expect(originalEventRow).toContainText("Superseded event v1");
  await expect(originalEventRow).toContainText(correctionReason);
  await expect(originalEventRow).toContainText(correction.correctionHash);
  await expect(originalEventRow).toContainText(
    "Correction locked; superseded events are immutable.",
  );
  await expect(
    originalEventRow.getByRole("button", { name: "Correct event" }),
  ).toHaveCount(0);
  const replacementEventRow = page.getByTestId(
    `procedural-event-${correction.replacement.id}`,
  );
  await expect(replacementEventRow).toContainText("Current confirmed v2");
  await expect(replacementEventRow).toContainText(
    correction.replacement.event_lineage_hash,
  );
  await expect(deadlineRow).toContainText("Stale · action blocked");
  await expect(deadlineRow).toContainText("Task invalidated");

  const refreshedRuleRow = page.getByTestId(`deadline-rule-${createdRule.id}`);
  const eventPicker = refreshedRuleRow.getByLabel(
    "Calculation event for Response after service",
  );
  await expect(eventPicker).toHaveValue(correction.replacement.id);
  await expect(
    eventPicker.locator(`option[value="${proceduralEvent.id}"]`),
  ).toHaveCount(0);

  const directOldCalculation = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/deadline-rules/${createdRule.id}/calculate`,
    {
      data: {
        eventId: proceduralEvent.id,
        title: "Old event must not calculate",
      },
    },
  );
  expect(directOldCalculation.ok()).toBe(false);

  const badCorrection = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/procedural-events/${correction.replacement.id}/corrections`,
    {
      data: {
        title: "Bad correction",
        occurredAt: "not-a-date",
        reason: "short",
      },
    },
  );
  expect(badCorrection.status()).toBe(400);
  const noOpCorrection = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/procedural-events/${correction.replacement.id}/corrections`,
    {
      data: {
        title: correction.replacement.title,
        occurredAt: correction.replacement.occurred_at,
        reason:
          "A no-op correction must fail without creating another version.",
      },
    },
  );
  expect(noOpCorrection.status()).toBe(400);
  const foreignMatterWrite = await page.request.post(
    `${apiBase}/aletheia/matters`,
    {
      data: {
        title: "Foreign correction probe",
        template: "civil_litigation",
        objective: "Ensure event writes remain matter scoped.",
        status: "in_progress",
      },
    },
  );
  const foreignMatter = (await foreignMatterWrite.json()) as { id: string };
  const unauthorizedCorrection = await page.request.post(
    `${apiBase}/aletheia/matters/${foreignMatter.id}/litigation/procedural-events/${correction.replacement.id}/corrections`,
    {
      data: {
        title: "Cross-matter correction must fail",
        occurredAt: "2026-07-13T02:00:00.000Z",
        reason:
          "The event does not belong to this matter and cannot be changed.",
      },
    },
  );
  expect(unauthorizedCorrection.status()).toBe(404);
  const secondWriteToSuperseded = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/procedural-events/${proceduralEvent.id}/corrections`,
    {
      data: {
        title: "Second correction of superseded event",
        occurredAt: "2026-07-13T02:00:00.000Z",
        reason: "A superseded event cannot be corrected a second time.",
      },
    },
  );
  expect(secondWriteToSuperseded.status()).toBe(404);

  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-12-event-corrections",
  );
  const assertViewport = async (width: number, height: number) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    const overlap = await page.evaluate(() => {
      const mobileHeader = document.querySelector<HTMLElement>(
        ".aletheia-mobile-header",
      );
      const scroller = document.querySelector<HTMLElement>(
        ".aletheia-shell > div > main.overflow-y-auto",
      );
      if (!mobileHeader || !scroller) return 0;
      return (
        mobileHeader.getBoundingClientRect().bottom -
        scroller.getBoundingClientRect().top
      );
    });
    expect(overlap).toBeLessThanOrEqual(1);
  };
  const capture = async (
    name: string,
    width: number,
    height: number,
    target: Locator,
  ) => {
    await assertViewport(width, height);
    await target.evaluate((element) =>
      element.scrollIntoView({ block: "start", behavior: "auto" }),
    );
    await page.waitForTimeout(100);
    if (
      process.env.ALETHEIA_CAPTURE_EVENT_CORRECTIONS === "true" &&
      testInfo.project.name === "desktop-chromium"
    ) {
      mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({
        path: path.join(screenshotDir, name),
        fullPage: true,
        animations: "disabled",
      });
    }
  };
  await capture(
    "01-correction-result-1440.png",
    1440,
    1000,
    page.getByTestId("event-correction-result"),
  );

  await refreshedRuleRow
    .getByLabel("Deadline title for Response after service")
    .fill("File response after corrected service");
  const correctedCalculationResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/deadline-rules/${createdRule.id}/calculate`),
  );
  await refreshedRuleRow
    .getByRole("button", { name: "Calculate proposal" })
    .click();
  const correctedDeadlineWrite = await correctedCalculationResponse;
  expect(correctedDeadlineWrite.status()).toBe(201);
  const correctedDeadline = (await correctedDeadlineWrite.json()) as {
    id: string;
    due_at: string;
  };
  expect(correctedDeadline.due_at).toBe("2026-07-22T15:59:59.000Z");
  const correctedDeadlineRow = page.locator("article").filter({
    hasText: "File response after corrected service",
  });
  await expect(correctedDeadlineRow).toContainText(
    "Due at local day end 2026-07-22 23:59:59 Asia/Shanghai.",
  );
  await expect(correctedDeadlineRow).toContainText("proposed");
  await expect(page.getByTestId("event-correction-result")).toContainText(
    "require a separate confirmation",
  );
  await capture(
    "02-lineage-stale-deadline-900.png",
    900,
    1000,
    originalEventRow,
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(originalEventRow).toContainText("Superseded event v1");
  await expect(replacementEventRow).toContainText("Current confirmed v2");
  await expect(deadlineRow).toContainText("Stale · action blocked");
  await expect(deadlineRow).toContainText("Task invalidated");
  await expect(correctedDeadlineRow).toContainText(
    "File response after corrected service",
  );
  await capture(
    "03-mobile-correction-lock-393.png",
    393,
    852,
    originalEventRow,
  );
});

test("counsel binds business-day deadlines to immutable court calendars", async ({
  page,
}, testInfo) => {
  const state = fixture(testInfo.project.name);
  const apiBase = `http://127.0.0.1:${state.backendPort}`;
  const matterWrite = await page.request.post(`${apiBase}/aletheia/matters`, {
    data: {
      title: `Court calendar lifecycle ${testInfo.project.name}`,
      template: "civil_litigation",
      objective: "Verify source-bound court business-day deadline handling.",
      status: "in_progress",
    },
  });
  expect(matterWrite.status()).toBe(201);
  const matter = (await matterWrite.json()) as { id: string };
  const matterUrl = `/aletheia/matters/${matter.id}/litigation?view=procedure`;
  const ruleQuote =
    "A response must be filed within three court business days after service.";
  const authorityWrite = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/legal-authorities`,
    {
      data: {
        authorityType: "regulation",
        title: "Shanghai Commercial Court 2026 procedure and schedule",
        issuer: "Shanghai Commercial Court",
        officialIdentifier: "SCC-CALENDAR-2026",
        versionLabel: "Official 2026 publication",
        sourceReference: "Shanghai Commercial Court official notice 2026-01",
        content: `${ruleQuote}\nThe 2026 court schedule records weekly closures and daily exceptions.`,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
      },
    },
  );
  expect(authorityWrite.status()).toBe(201);
  const authority = (await authorityWrite.json()) as { id: string };
  const authorityVerify = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/legal-authorities/${authority.id}/verify`,
    {
      data: {
        comment:
          "Counsel compared the procedure and annual schedule against the official court publication.",
      },
    },
  );
  expect(authorityVerify.status()).toBe(200);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(matterUrl);
  await page.getByLabel("Procedural event type").selectOption("service");
  await page
    .getByLabel("Procedural event title")
    .fill("Service triggering court-business-day response");
  await page
    .getByLabel("Procedural event date and time")
    .fill("2026-07-01T10:00");
  const eventResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/litigation/procedural-events`),
  );
  await page.getByRole("button", { name: "Add event" }).click();
  const proceduralEvent = (await (await eventResponse).json()) as {
    id: string;
  };
  const eventRow = page.getByTestId(`procedural-event-${proceduralEvent.id}`);
  await eventRow.getByRole("button", { name: "Confirm" }).click();
  await expect(eventRow).toContainText("Current confirmed v1");

  await page.getByLabel("Court identifier").fill("SH-COMMERCIAL-COURT");
  await page
    .getByLabel("Calendar name")
    .fill("Shanghai Commercial Court working calendar");
  await page
    .getByLabel("Calendar version label")
    .fill("2026 official schedule");
  await page.getByLabel("Calendar source authority").selectOption(authority.id);
  await page.getByLabel("Calendar effective from").fill("2026-01-01");
  await page.getByLabel("Calendar effective to").fill("2026-12-31");
  await expect(page.getByLabel("Sat non-working")).toBeChecked();
  await expect(page.getByLabel("Sun non-working")).toBeChecked();
  await page.getByRole("button", { name: "Add exception" }).click();
  await page.getByLabel("Exception 1 date").fill("2026-07-03");
  await page.getByLabel("Exception 1 disposition").selectOption("closed");
  await page
    .getByLabel("Exception 1 source reference")
    .fill("Official closure schedule item 7");
  await page.getByRole("button", { name: "Add exception" }).click();
  await page.getByLabel("Exception 2 date").fill("2026-07-04");
  await page.getByLabel("Exception 2 disposition").selectOption("open");
  await page
    .getByLabel("Exception 2 source reference")
    .fill("Official make-up opening schedule item 8");
  const calendarRequest = page.waitForRequest((request) =>
    request.url().endsWith(`/litigation/court-calendars`),
  );
  const calendarResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/litigation/court-calendars`),
  );
  await page.getByRole("button", { name: "Create draft calendar" }).click();
  expect((await calendarRequest).postDataJSON()).toEqual({
    courtIdentifier: "SH-COMMERCIAL-COURT",
    name: "Shanghai Commercial Court working calendar",
    versionLabel: "2026 official schedule",
    sourceAuthorityVersionId: authority.id,
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
    weeklyNonWorkingDays: [0, 6],
    overrides: [
      {
        localDate: "2026-07-03",
        disposition: "closed",
        sourceReference: "Official closure schedule item 7",
      },
      {
        localDate: "2026-07-04",
        disposition: "open",
        sourceReference: "Official make-up opening schedule item 8",
      },
    ],
  });
  const calendar = (await (await calendarResponse).json()) as {
    id: string;
    calendar_hash: string;
  };
  expect(calendar.calendar_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  const calendarRow = page.getByTestId(`court-calendar-${calendar.id}`);
  await expect(calendarRow).toContainText("draft");
  await expect(calendarRow).toContainText("open make-up");
  await expect(calendarRow).toContainText(calendar.calendar_hash);

  await page.getByLabel("Counting basis").selectOption("business_days");
  await expect(
    page
      .getByLabel("Rule court calendar version")
      .locator(`option[value="${calendar.id}"]`),
  ).toHaveCount(0);
  const draftCalendarRule = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/deadline-rules`,
    {
      data: {
        name: "Draft calendar must fail",
        triggerEventType: "service",
        authorityVersionId: authority.id,
        provisionReference: "Article 3",
        exactQuote: ruleQuote,
        offsetDays: 3,
        countingBasis: "business_days",
        courtCalendarVersionId: calendar.id,
        startPolicy: "next_day",
      },
    },
  );
  expect(draftCalendarRule.status()).toBe(400);

  const calendarVerificationReason =
    "Counsel checked the weekly closures and both dated exceptions against the official schedule.";
  await calendarRow
    .getByLabel(
      "Calendar verification reason for Shanghai Commercial Court working calendar",
    )
    .fill(calendarVerificationReason);
  const verifyCalendarRequest = page.waitForRequest((request) =>
    request.url().endsWith(`/court-calendars/${calendar.id}/verify`),
  );
  await calendarRow.getByRole("button", { name: "Verify calendar" }).click();
  expect((await verifyCalendarRequest).postDataJSON()).toEqual({
    comment: calendarVerificationReason,
  });
  await expect(calendarRow).toContainText(
    `Verified: ${calendarVerificationReason}`,
  );
  await expect(
    page
      .getByLabel("Rule court calendar version")
      .locator(`option[value="${calendar.id}"]`),
  ).toHaveCount(1);

  await page.getByLabel("Rule name").fill("Three court-business-day response");
  await page.getByLabel("Rule trigger event type").selectOption("service");
  await page.getByLabel("Rule authority version").selectOption(authority.id);
  await page.getByLabel("Provision reference").fill("Article 3");
  await page.getByLabel("Day offset").fill("3");
  await page.getByLabel("Exact provision quote").fill(ruleQuote);
  await page.getByLabel("Counting starts").selectOption("next_day");
  await page
    .getByLabel("Rule court calendar version")
    .selectOption(calendar.id);
  const ruleRequest = page.waitForRequest((request) =>
    request.url().endsWith(`/litigation/deadline-rules`),
  );
  const ruleResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/litigation/deadline-rules`),
  );
  await page.getByRole("button", { name: "Create draft rule" }).click();
  expect((await ruleRequest).postDataJSON()).toMatchObject({
    countingBasis: "business_days",
    courtCalendarVersionId: calendar.id,
    offsetDays: 3,
  });
  const rule = (await (await ruleResponse).json()) as {
    id: string;
    rule_hash: string;
    court_calendar_hash: string;
  };
  expect(rule.court_calendar_hash).toBe(calendar.calendar_hash);
  const ruleRow = page.getByTestId(`deadline-rule-${rule.id}`);
  await expect(ruleRow).toContainText("3 court business days");
  await expect(ruleRow).toContainText(calendar.id);
  await expect(ruleRow).toContainText(calendar.calendar_hash);
  const ruleVerificationReason =
    "Counsel verified the exact provision and bound court calendar version for business-day counting.";
  await ruleRow
    .getByLabel("Verification reason for Three court-business-day response")
    .fill(ruleVerificationReason);
  await ruleRow.getByRole("button", { name: "Verify rule" }).click();
  await expect(ruleRow).toContainText(`Verified: ${ruleVerificationReason}`);

  await ruleRow
    .getByLabel("Calculation event for Three court-business-day response")
    .selectOption(proceduralEvent.id);
  await ruleRow
    .getByLabel("Deadline title for Three court-business-day response")
    .fill("Business-day response deadline");
  const deadlineResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/deadline-rules/${rule.id}/calculate`),
  );
  await ruleRow.getByRole("button", { name: "Calculate proposal" }).click();
  const deadline = (await (await deadlineResponse).json()) as {
    id: string;
    due_at: string;
    court_calendar_version_id: string;
    court_calendar_hash: string;
  };
  expect(deadline.due_at).toBe("2026-07-06T15:59:59.000Z");
  expect(deadline.court_calendar_version_id).toBe(calendar.id);
  expect(deadline.court_calendar_hash).toBe(calendar.calendar_hash);
  const deadlineRow = page.locator("article").filter({
    hasText: "Business-day response deadline",
  });
  await expect(deadlineRow).toContainText(
    "Due at local day end 2026-07-06 23:59:59 Asia/Shanghai.",
  );
  await expect(deadlineRow).toContainText("Working day");
  await expect(deadlineRow).toContainText("Closed exception");
  await expect(deadlineRow).toContainText("Open make-up day");
  await expect(deadlineRow).toContainText("Weekend / weekly closure");
  await expect(deadlineRow).toContainText(
    "aletheia-court-calendar-business-days-v1",
  );
  await deadlineRow.getByRole("button", { name: "Confirm" }).click();
  await deadlineRow.getByRole("button", { name: "Add to work queue" }).click();
  await expect(deadlineRow).toContainText("状态：待办");

  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-12-court-calendars",
  );
  const assertLayout = async (width: number, height: number) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    const audit = await page.evaluate(() => {
      const mobileHeader = document.querySelector<HTMLElement>(
        ".aletheia-mobile-header",
      );
      const scroller = document.querySelector<HTMLElement>(
        ".aletheia-shell > div > main.overflow-y-auto",
      );
      const headerOverlap =
        mobileHeader && scroller
          ? mobileHeader.getBoundingClientRect().bottom -
            scroller.getBoundingClientRect().top
          : 0;
      const mainOverflow = scroller
        ? scroller.scrollWidth - scroller.clientWidth
        : 0;
      const controls = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid="court-calendars-workspace"] input, [data-testid="court-calendars-workspace"] select, [data-testid="court-calendars-workspace"] button',
        ),
      ].filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0
        );
      });
      const horizontallyClipped = controls.some((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left < -1 ||
          rect.right > document.documentElement.clientWidth + 1
        );
      });
      const overlaps = controls.some((left, index) =>
        controls.slice(index + 1).some((right) => {
          const a = left.getBoundingClientRect();
          const b = right.getBoundingClientRect();
          return (
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
          );
        }),
      );
      return { headerOverlap, mainOverflow, horizontallyClipped, overlaps };
    });
    expect(audit.headerOverlap).toBeLessThanOrEqual(1);
    expect(audit.mainOverflow).toBeLessThanOrEqual(1);
    expect(audit.horizontallyClipped).toBe(false);
    expect(audit.overlaps).toBe(false);
  };
  const capture = async (
    name: string,
    width: number,
    height: number,
    target: Locator,
  ) => {
    await assertLayout(width, height);
    await target.evaluate((element) =>
      element.scrollIntoView({ block: "start", behavior: "auto" }),
    );
    await page.waitForTimeout(100);
    if (
      process.env.ALETHEIA_CAPTURE_COURT_CALENDARS === "true" &&
      testInfo.project.name === "desktop-chromium"
    ) {
      mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({
        path: path.join(screenshotDir, name),
        animations: "disabled",
      });
    }
  };
  await capture(
    "01-verified-calendar-1440x1000.png",
    1440,
    1000,
    page.getByTestId("court-calendars-workspace"),
  );
  await capture(
    "02-business-day-trace-900x1000.png",
    900,
    1000,
    page.getByTestId(`business-day-trace-${deadline.id}`),
  );
  await capture(
    "03-business-day-trace-393x852.png",
    393,
    852,
    page.getByTestId(`business-day-trace-${deadline.id}`),
  );

  const shortRetirement = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/court-calendars/${calendar.id}/retire`,
    { data: { comment: "short" } },
  );
  expect(shortRetirement.status()).toBe(400);
  const foreignMatterWrite = await page.request.post(
    `${apiBase}/aletheia/matters`,
    {
      data: {
        title: "Foreign court calendar probe",
        template: "civil_litigation",
        objective: "Verify calendar matter isolation.",
        status: "in_progress",
      },
    },
  );
  const foreignMatter = (await foreignMatterWrite.json()) as { id: string };
  const crossMatterVerify = await page.request.post(
    `${apiBase}/aletheia/matters/${foreignMatter.id}/litigation/court-calendars/${calendar.id}/verify`,
    {
      data: {
        comment:
          "A calendar from another matter must not be available for verification.",
      },
    },
  );
  expect(crossMatterVerify.status()).toBe(404);
  const malformedCalendar = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/court-calendars`,
    {
      data: {
        courtIdentifier: "SH-COMMERCIAL-COURT",
        name: "Malformed duplicate exception calendar",
        versionLabel: "invalid",
        sourceAuthorityVersionId: authority.id,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
        weeklyNonWorkingDays: [0, 6],
        overrides: [
          {
            localDate: "2026-07-03",
            disposition: "closed",
            sourceReference: "Official item 1",
          },
          {
            localDate: "2026-07-03",
            disposition: "open",
            sourceReference: "Official item 2",
          },
        ],
      },
    },
  );
  expect(malformedCalendar.status()).toBe(400);

  await page.setViewportSize({ width: 1440, height: 1000 });
  const retirementReason =
    "Counsel retired this schedule after the court published a replacement calendar version.";
  await calendarRow
    .getByLabel(
      "Calendar retirement reason for Shanghai Commercial Court working calendar",
    )
    .fill(retirementReason);
  const retirementResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/court-calendars/${calendar.id}/retire`),
  );
  await calendarRow.getByRole("button", { name: "Retire calendar" }).click();
  const retirement = (await (await retirementResponse).json()) as {
    retiredRules: number;
    invalidatedDeadlines: number;
    invalidatedTasks: number;
  };
  expect(retirement).toMatchObject({
    retiredRules: 1,
    invalidatedDeadlines: 1,
    invalidatedTasks: 1,
  });
  await expect(calendarRow).toContainText(`Retired: ${retirementReason}`);
  await expect(ruleRow).toContainText("retired");
  await expect(deadlineRow).toContainText("Stale · action blocked");
  await expect(deadlineRow).toContainText("Task invalidated");
  await expect(deadlineRow).toContainText(
    "Recovery: verify a replacement calendar",
  );
  await page.getByLabel("Counting basis").selectOption("business_days");
  await expect(
    page
      .getByLabel("Rule court calendar version")
      .locator(`option[value="${calendar.id}"]`),
  ).toHaveCount(0);
  await page.reload();
  await expect(calendarRow).toContainText("retired");
  await expect(ruleRow).toContainText("retired");
  await expect(deadlineRow).toContainText("Stale · action blocked");
  await expect(deadlineRow).toContainText("Task invalidated");
  const repeatRetirement = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/court-calendars/${calendar.id}/retire`,
    {
      data: {
        comment:
          "A retired immutable calendar cannot be retired a second time.",
      },
    },
  );
  expect(repeatRetirement.status()).toBe(404);
});

test("reviewed retrieval excerpts survive refresh and remain outside conclusions", async ({
  page,
}, testInfo) => {
  const state = fixture(testInfo.project.name);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${state.matterUrl}?view=facts`);
  const panel = page
    .getByRole("heading", {
      name: "Reviewed retrieval excerpts",
    })
    .locator("xpath=ancestor::section[1]");
  await expect(panel).toContainText("Candidates do not enter conclusions");
  await expect(panel).toContainText("Document changes require a new retrieval");

  await page
    .getByPlaceholder("Search focus, e.g. payment due date")
    .fill("付款记录显示");
  const manifestResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(
          `/aletheia/matters/${state.matterId}/litigation/retrieval-manifests`,
        ),
  );
  await page.getByRole("button", { name: "Retrieve" }).click();
  expect((await manifestResponse).status()).toBe(201);
  await expect(panel.getByText("Complete candidates")).toBeVisible();
  await expect(panel).toContainText("Complete set: yes");
  await expect(panel).toContainText("Input binding: no");

  const candidate = panel.locator("article").first();
  await candidate
    .getByPlaceholder(
      "Explain why this exact excerpt is relevant (10+ characters).",
    )
    .fill("This exact source records the disputed procedural date.");
  const confirmResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/retrieval-manifests/") &&
      response.url().endsWith("/excerpts"),
  );
  await candidate.getByRole("button", { name: "Confirm excerpt" }).click();
  expect((await confirmResponse).status()).toBe(201);
  await expect(candidate.getByText("Confirmed", { exact: true })).toBeVisible();
  await expect(candidate).toContainText(
    "This exact source records the disputed procedural date.",
  );

  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-11-reviewed-excerpts",
  );
  const capture = async (name: string, width: number, height: number) => {
    await page.setViewportSize({ width, height });
    await panel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: path.join(screenshotDir, `${name}.png`),
      animations: "disabled",
    });
  };

  if (
    process.env.ALETHEIA_CAPTURE_REVIEWED_EXCERPTS === "true" &&
    testInfo.project.name === "desktop-chromium"
  ) {
    mkdirSync(screenshotDir, { recursive: true });
    await capture("01-confirmed-desktop", 1440, 1100);
  }

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Reviewed retrieval excerpts" }),
  ).toBeVisible();
  const restoredPanel = page
    .getByRole("heading", {
      name: "Reviewed retrieval excerpts",
    })
    .locator("xpath=ancestor::section[1]");
  const restoredCandidate = restoredPanel.locator("article").first();
  await expect(
    restoredCandidate.getByText("Confirmed", { exact: true }),
  ).toBeVisible();
  await expect(restoredPanel).toContainText("Confirmed 1");

  await restoredCandidate
    .getByPlaceholder(
      "Record why this excerpt should be withdrawn (10+ characters).",
    )
    .fill("The excerpt is no longer needed for this review focus.");
  const withdrawResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/retrieval-excerpts/") &&
      response.url().endsWith("/withdraw"),
  );
  await restoredCandidate
    .getByRole("button", { name: "Withdraw excerpt" })
    .click();
  expect((await withdrawResponse).status()).toBe(200);
  await expect(
    restoredCandidate.getByText("Withdrawn", { exact: true }),
  ).toBeVisible();
  await expect(restoredCandidate).toContainText(
    "The excerpt is no longer needed for this review focus.",
  );

  if (process.env.ALETHEIA_CAPTURE_REVIEWED_EXCERPTS === "true") {
    mkdirSync(screenshotDir, { recursive: true });
    if (testInfo.project.name === "desktop-chromium") {
      await capture("02-withdrawn-900px", 900, 1100);
    } else {
      await capture("03-withdrawn-mobile", 393, 852);
    }
  }

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("counsel explicitly binds only current confirmed retrieval excerpts to an agent run", async ({
  page,
}, testInfo) => {
  const state = fixture(testInfo.project.name);
  const mobile = testInfo.project.name === "mobile-chromium";
  await page.setViewportSize(
    mobile ? { width: 393, height: 852 } : { width: 1440, height: 1000 },
  );

  let persistedRun: Record<string, unknown> | null = null;
  let rejectBoundRun = true;
  const submittedBodies: Array<Record<string, unknown>> = [];
  await page.route("**/aletheia/durable-executor/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, modelId: "local-counsel-model" }),
    }),
  );
  await page.route(
    "**/aletheia/matters/*/litigation-durable-runs/latest",
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(persistedRun),
      }),
  );
  await page.route(
    "**/aletheia/matters/*/litigation-durable-runs",
    async (route) => {
      const body = (await route.request().postDataJSON()) as Record<
        string,
        unknown
      >;
      submittedBodies.push(body);
      if (rejectBoundRun) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "Reviewed retrieval manifest is no longer hash-valid.",
          }),
        });
        return;
      }
      persistedRun = {
        id: "run-reviewed-input-binding",
        matter_id: state.matterId,
        workflow: "aletheia-civil-litigation-harness-v1",
        goal: "Prepare a source-grounded litigation analysis.",
        status: "succeeded",
        attempt_count: 1,
        deadline_at: "2026-07-11T12:00:00.000Z",
        error: null,
        metadata: {
          statePolicy: "confirmed_cited_no_open_review",
          retrievalFocus: "付款记录显示",
          retrievalInputBinding: {
            manifestId: body.retrievalManifestId,
            confirmedExcerptIds: ["confirmed-excerpt-1"],
          },
        },
        steps: [],
        events: [],
      };
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify(persistedRun),
      });
    },
  );
  await page.route(
    "**/aletheia/durable-runs/run-reviewed-input-binding/integrity",
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, eventCount: 0, lastHash: null }),
      }),
  );

  await page.goto(`${state.matterUrl}?view=facts`);
  const panel = page
    .getByRole("heading", {
      name: "Reviewed retrieval excerpts",
    })
    .locator("xpath=ancestor::section[1]");
  await page
    .getByPlaceholder("Search focus, e.g. payment due date")
    .fill("付款记录显示");
  const manifestWrite = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/litigation/retrieval-manifests"),
  );
  await page.getByRole("button", { name: "Retrieve" }).click();
  expect((await manifestWrite).status()).toBe(201);
  const candidate = panel.locator("article").first();
  await candidate
    .getByPlaceholder(
      "Explain why this exact excerpt is relevant (10+ characters).",
    )
    .fill("Counsel confirmed this exact excerpt for the bounded Agent run.");
  const confirmationWrite = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/excerpts"),
  );
  await candidate.getByRole("button", { name: "Confirm excerpt" }).click();
  expect((await confirmationWrite).status()).toBe(201);

  await page.goto(`${state.matterUrl}?view=agent`);
  await expect(page.getByText("Reviewed retrieval input")).toBeVisible();
  const binding = page.getByRole("checkbox", {
    name: /Bind 1 confirmed excerpt to this run/,
  });
  await expect(binding).not.toBeChecked();
  await expect(page.getByText(/\d+ candidates · 1 confirmed/)).toBeVisible();
  await expect(
    page.getByText(
      "Only confirmed excerpts are admitted. Withdrawn excerpts are excluded.",
    ),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByText("Reviewed retrieval input")).toBeVisible();
  await expect(binding).not.toBeChecked();
  const manifestRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/litigation/retrieval-manifests/"),
  );
  await binding.click();
  const manifestReadResponse = await manifestRead;
  expect(manifestReadResponse.ok()).toBe(true);
  expect((await manifestReadResponse.json()).bindingEligibility).toMatchObject({
    eligible: true,
  });
  await expect(binding).toBeChecked();
  await expect(
    page.getByText("Analysis focus from reviewed manifest"),
  ).toBeVisible();

  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-11-agent-input-binding",
  );
  mkdirSync(screenshotDir, { recursive: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  if (mobile) {
    const headerGeometry = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(
        ".aletheia-mobile-header",
      );
      const scroller = document.querySelector<HTMLElement>(
        ".aletheia-shell > div > main.overflow-y-auto",
      );
      if (!header || !scroller) return null;
      const headerRect = header.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      return {
        headerBottom: headerRect.bottom,
        scrollerTop: scrollerRect.top,
        overlap: headerRect.bottom - scrollerRect.top,
      };
    });
    expect(headerGeometry).not.toBeNull();
    expect(headerGeometry!.overlap).toBeLessThanOrEqual(1);
    await page
      .getByRole("heading", { name: "Litigation agent run" })
      .evaluate((element) => {
        let parent = element.parentElement;
        while (parent) {
          if (/(auto|scroll)/.test(window.getComputedStyle(parent).overflowY)) {
            const offset =
              element.getBoundingClientRect().top -
              parent.getBoundingClientRect().top;
            parent.scrollTop += offset - 20;
            return;
          }
          parent = parent.parentElement;
        }
      });
  }
  await page.waitForTimeout(100);
  const screenshotPath = path.join(
    screenshotDir,
    mobile
      ? "02-binding-active-mobile-393.png"
      : "01-binding-active-desktop.png",
  );
  if (mobile) {
    await page
      .getByRole("heading", { name: "Litigation agent run" })
      .locator("xpath=ancestor::section[1]")
      .screenshot({ path: screenshotPath, animations: "disabled" });
  } else {
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
      animations: "disabled",
    });
  }

  await page.getByRole("button", { name: "Start case analysis" }).click();
  await expect(
    page.getByText("Reviewed retrieval manifest is no longer hash-valid."),
  ).toBeVisible();
  await expect(binding).not.toBeChecked();

  const staleManifestHandler = async (route: Route) => {
    const response = await route.fetch();
    const manifest = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      contentType: "application/json",
      body: JSON.stringify({
        ...manifest,
        bindingEligibility: {
          eligible: false,
          reason: "Document index changed; retrieve and review again.",
        },
      }),
    });
  };
  await page.route("**/litigation/retrieval-manifests/*", staleManifestHandler);
  await binding.click();
  await expect(binding).not.toBeChecked();
  await expect(binding).toBeDisabled();
  await expect(
    page.getByText("Document index changed; retrieve and review again.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.unroute(
    "**/litigation/retrieval-manifests/*",
    staleManifestHandler,
  );
  await page.getByRole("button", { name: "事实与证据" }).click();
  await expect(candidate.getByText("Confirmed", { exact: true })).toBeVisible();
  await page.goto(`${state.matterUrl}?view=agent`);
  await expect(binding).toBeEnabled();

  rejectBoundRun = false;
  await binding.click();
  await expect(binding).toBeChecked();
  await page.getByRole("button", { name: "Start case analysis" }).click();
  await expect(
    page.getByText("Reviewed input bound · 1 confirmed excerpt"),
  ).toBeVisible();
  expect(submittedBodies).toHaveLength(2);
  expect(submittedBodies[1]).toEqual({
    retrievalManifestId: submittedBodies[0].retrievalManifestId,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});

test("source citation inspector records an explicit counsel text comparison and preserves retry state", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const state = fixture(testInfo.project.name);
  const apiBase = `http://127.0.0.1:${state.backendPort}`;
  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-12-in-viewer-verification",
  );
  mkdirSync(screenshotDir, { recursive: true });
  const withdrawalScreenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-12-source-verification-withdrawal",
  );
  mkdirSync(withdrawalScreenshotDir, { recursive: true });
  const historyScreenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-12-source-verification-history",
  );
  mkdirSync(historyScreenshotDir, { recursive: true });
  const workspaceResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${state.matterId}/litigation`,
  );
  const baseWorkspace = (await workspaceResponse.json()) as {
    fact_sources: Array<{
      source_span_id: string;
      document_id: string;
      document_name: string;
      quote: string;
      metadata?: { ocrProvenance?: { confidence?: number; page?: number } };
    }>;
  };
  const citation = baseWorkspace.fact_sources.find(
    (source) => Number(source.metadata?.ocrProvenance?.confidence) < 0.7,
  );
  expect(citation).toBeTruthy();
  let recordedPage = 2;
  const pdf = citationPdfFixture();
  const verificationRequests: Array<{
    url: string;
    body: Record<string, unknown>;
  }> = [];
  let failNextVerification = true;
  let persistedVerificationId: string | null = null;
  const withdrawalRequests: Array<{
    url: string;
    body: Record<string, unknown>;
  }> = [];
  let failNextWithdrawal = true;
  let releaseFailedWithdrawal: () => void = () => {};
  let failNextHistory = true;
  const historyRequests: string[] = [];
  const sourceChunkSha256 = "a".repeat(64);
  const quoteSha256 = "b".repeat(64);
  let historyItems: Array<Record<string, unknown>> = [];

  await page.route(
    (url) =>
      url.pathname === `/aletheia/matters/${state.matterId}` &&
      url.origin === apiBase,
    async (route) => {
      const response = await route.fetch();
      const matter = (await response.json()) as {
        documents: Array<{
          id: string;
          metadata: Record<string, unknown>;
        }>;
      };
      await route.fulfill({
        response,
        body: JSON.stringify({
          ...matter,
          documents: matter.documents.map((document) =>
            document.id === citation!.document_id
              ? {
                  ...document,
                  metadata: {
                    ...document.metadata,
                    mimeType: "application/pdf",
                  },
                }
              : document,
          ),
        }),
      });
    },
  );
  await page.route(
    (url) =>
      url.pathname === `/aletheia/matters/${state.matterId}/litigation` &&
      url.origin === apiBase,
    async (route) => {
      const response = await route.fetch();
      const workspace = (await response.json()) as {
        fact_sources: Array<
          Record<string, unknown> & {
            document_id: string;
            metadata?: Record<string, unknown> & {
              ocrProvenance?: Record<string, unknown>;
            };
          }
        >;
      };
      await route.fulfill({
        response,
        body: JSON.stringify({
          ...workspace,
          fact_sources: workspace.fact_sources.map((source) =>
            source.document_id === citation!.document_id
              ? {
                  ...source,
                  page: recordedPage,
                  current_verification_id: persistedVerificationId,
                  verification_reason: persistedVerificationId
                    ? "Counsel comparison persisted by viewer fixture."
                    : null,
                  verified_at: persistedVerificationId
                    ? "2026-07-12T08:00:00.000Z"
                    : null,
                  metadata: {
                    ...source.metadata,
                    ocrProvenance: {
                      ...source.metadata?.ocrProvenance,
                      page: recordedPage,
                      confidence: 0.55,
                    },
                  },
                }
              : source,
          ),
        }),
      });
    },
  );
  await page.route(
    `**/aletheia/matters/${state.matterId}/litigation/source-spans/${citation!.source_span_id}/original-verification-history`,
    async (route) => {
      expect(route.request().method()).toBe("GET");
      expect(route.request().postData()).toBeNull();
      historyRequests.push(route.request().url());
      if (failNextHistory) {
        failNextHistory = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ detail: "history temporarily unavailable" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          source_span_id: citation!.source_span_id,
          items: historyItems,
        }),
      });
    },
  );
  await page.route(
    `**/aletheia/matters/${state.matterId}/litigation/source-spans/${citation!.source_span_id}/verify-original`,
    async (route) => {
      verificationRequests.push({
        url: route.request().url(),
        body: route.request().postDataJSON() as Record<string, unknown>,
      });
      if (failNextVerification) {
        failNextVerification = false;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "/private/owner/database.sqlite actor ACL internals",
          }),
        });
        return;
      }
      persistedVerificationId = "viewer-verification-fixture";
      historyItems = [
        {
          verification_id: persistedVerificationId,
          source_chunk_sha256: sourceChunkSha256,
          quote_sha256: quoteSha256,
          reason: verificationRequests.at(-1)!.body.reason,
          verified_by: "authenticated-actor-fixture",
          verified_at: "2026-07-12T08:00:00.000Z",
          current: true,
        },
      ];
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: persistedVerificationId,
          source_span_id: citation!.source_span_id,
          reason: verificationRequests.at(-1)!.body.reason,
          verified_by: "authenticated-actor-fixture",
          verified_at: "2026-07-12T08:00:00.000Z",
        }),
      });
    },
  );
  await page.route(
    `**/aletheia/matters/${state.matterId}/litigation/source-spans/${citation!.source_span_id}/verifications/*/withdraw`,
    async (route) => {
      withdrawalRequests.push({
        url: route.request().url(),
        body: route.request().postDataJSON() as Record<string, unknown>,
      });
      if (failNextWithdrawal) {
        failNextWithdrawal = false;
        await new Promise<void>((resolve) => {
          releaseFailedWithdrawal = resolve;
        });
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "/private/owner/database.sqlite actor ACL internals",
          }),
        });
        return;
      }
      const withdrawnVerificationId = persistedVerificationId;
      persistedVerificationId = null;
      historyItems = historyItems.map((item) => ({
        ...item,
        current: false,
        withdrawal: {
          id: "viewer-withdrawal-fixture",
          reason: withdrawalRequests.at(-1)!.body.reason,
          withdrawn_by: "authenticated-actor-fixture",
          withdrawn_at: "2026-07-12T09:00:00.000Z",
        },
      }));
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "viewer-withdrawal-fixture",
          source_span_id: citation!.source_span_id,
          verification_id: withdrawnVerificationId,
          reason: withdrawalRequests.at(-1)!.body.reason,
          withdrawn_by: "authenticated-actor-fixture",
          withdrawn_at: "2026-07-12T09:00:00.000Z",
        }),
      });
    },
  );
  await page.route(
    `**/aletheia/matters/${state.matterId}/documents/${citation!.document_id}/original`,
    (route) =>
      route.fulfill({
        status: 200,
        body: pdf,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers":
            "Content-Length, X-Aletheia-Content-Sha256",
          "content-length": String(pdf.length),
          "content-type": "application/pdf",
          "x-aletheia-content-sha256": createHash("sha256")
            .update(pdf)
            .digest("hex"),
        },
      }),
  );

  const beforeResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${state.matterId}`,
  );
  const before = (await beforeResponse.json()) as {
    auditEvents: Array<{ action: string }>;
  };
  const beforeComparisons = before.auditEvents.filter(
    (event) => event.action === "litigation_source_original_scan_verified",
  ).length;

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${state.matterUrl}?view=facts`);
  const inspect = page
    .getByRole("button", {
      name: new RegExp(
        `Inspect original ${citation!.document_name}.*recorded citation page`,
      ),
    })
    .first();
  await expect(inspect).toBeVisible();
  await inspect.click();
  const viewer = page.getByTestId("original-evidence-viewer");
  await expect(viewer.getByLabel("PDF page position")).toHaveText("Page 2 / 3");
  await expect(viewer).toContainText(
    "Recorded citation page 2. Comparison is available only while that exact page is displayed.",
  );
  const inspector = viewer.getByTestId("original-comparison-inspector");
  await expect(inspector).toContainText("Original text comparison");
  await expect(inspector).toContainText(citation!.quote);
  await expect(inspector).toContainText("Recorded page");
  await expect(inspector).toContainText("Currently displayed page");
  await expect(inspector).toContainText("55%");
  await expect(inspector).toContainText(
    "transcription comparison only, not authenticity, admissibility, file safety, or substantive truth",
  );
  const history = inspector.getByTestId("original-verification-history");
  await expect(history.getByRole("alert")).toContainText(
    "Verification history is unavailable. This is not an empty history.",
  );
  await expect(history).not.toContainText(
    "No verification or withdrawal has been recorded",
  );
  expect(historyRequests).toEqual([
    `${apiBase}/aletheia/matters/${state.matterId}/litigation/source-spans/${citation!.source_span_id}/original-verification-history`,
  ]);
  await history.locator("summary").click();
  await history.locator("summary").click();
  expect(verificationRequests).toHaveLength(0);
  expect(withdrawalRequests).toHaveLength(0);
  await history.getByRole("button", { name: "Retry history" }).click();
  await expect(history).toContainText(
    "No verification or withdrawal has been recorded for this citation.",
  );
  expect(historyRequests).toHaveLength(2);
  const canvas = viewer.getByTestId("original-evidence-canvas");
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const target = element as HTMLCanvasElement;
        if (!target.width || !target.height) return 0;
        const context = target.getContext("2d");
        if (!context) return 0;
        const pixels = context.getImageData(
          0,
          0,
          target.width,
          target.height,
        ).data;
        let painted = 0;
        for (let index = 0; index < pixels.length; index += 16) {
          if (
            pixels[index] < 245 ||
            pixels[index + 1] < 245 ||
            pixels[index + 2] < 245
          ) {
            painted += 1;
          }
        }
        return painted;
      }),
    )
    .toBeGreaterThan(25);

  const reasonInput = inspector.getByLabel("Counsel comparison reason");
  const submit = inspector.getByRole("button", {
    name: "Record text comparison",
  });
  await reasonInput.fill("Too short");
  await expect(submit).toBeDisabled();
  expect(verificationRequests).toHaveLength(0);

  const reason =
    "Compared the displayed payment date and wording with recorded page 2 in the protected original.";
  await reasonInput.fill(reason);
  await expect(submit).toBeEnabled();
  await viewer.getByRole("button", { name: "Next page" }).click();
  await expect(viewer.getByLabel("PDF page position")).toHaveText("Page 3 / 3");
  await expect(inspector).toContainText("Currently displayed page3");
  await expect(submit).toBeDisabled();
  const returnToRecordedPage = inspector.getByRole("button", {
    name: "Return to recorded page 2",
  });
  await expect(returnToRecordedPage).toBeVisible();
  await expect(reasonInput).toHaveValue(reason);
  expect(verificationRequests).toHaveLength(0);
  expect(withdrawalRequests).toHaveLength(0);

  await viewer.getByRole("button", { name: "Zoom in" }).click();
  await expect(viewer.getByLabel("PDF zoom level")).toHaveText("125%");
  const downloadPromise = page.waitForEvent("download");
  await viewer.getByRole("button", { name: "Save & open original" }).click();
  await downloadPromise;
  expect(verificationRequests).toHaveLength(0);
  expect(withdrawalRequests).toHaveLength(0);

  await returnToRecordedPage.click();
  await expect(viewer.getByLabel("PDF page position")).toHaveText("Page 2 / 3");
  await expect(inspector).toContainText("Currently displayed page2");
  await expect(returnToRecordedPage).toHaveCount(0);
  await expect(reasonInput).toHaveValue(reason);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(inspector.getByRole("alert")).toContainText(
    "could not be recorded",
  );
  await expect(reasonInput).toHaveValue(reason);
  await expect(viewer).not.toContainText("/private/");
  expect(verificationRequests).toEqual([
    {
      url: `${apiBase}/aletheia/matters/${state.matterId}/litigation/source-spans/${citation!.source_span_id}/verify-original`,
      body: { reason },
    },
  ]);
  expect(verificationRequests[0].body).not.toHaveProperty("verified_by");
  await assertComparisonViewerVisualIntegrity(page);
  await page.screenshot({
    path: path.join(
      screenshotDir,
      "in-viewer-verification-desktop-1440x1000.png",
    ),
  });

  await viewer
    .getByRole("button", { name: "Close original inspector" })
    .click();
  await expect(viewer).toBeHidden();
  await page.setViewportSize({ width: 393, height: 852 });
  const mobileInspect = page
    .getByRole("button", {
      name: new RegExp(
        `Inspect original ${citation!.document_name}.*recorded citation page`,
      ),
    })
    .first();
  await mobileInspect.click();
  await expect(viewer.getByLabel("PDF page position")).toHaveText("Page 2 / 3");
  const mobileInspector = viewer.getByTestId("original-comparison-inspector");
  const mobileReasonInput = mobileInspector.getByLabel(
    "Counsel comparison reason",
  );
  await mobileReasonInput.fill(reason);
  const mobileSubmit = mobileInspector.getByRole("button", {
    name: "Record text comparison",
  });
  await mobileSubmit.scrollIntoViewIfNeeded();
  await expect(mobileSubmit).toBeInViewport();
  await assertComparisonViewerVisualIntegrity(page);

  await page.setViewportSize({ width: 393, height: 1200 });
  await mobileInspector.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(
    mobileInspector.getByText("Original text comparison", { exact: true }),
  ).toBeInViewport();
  await expect(mobileInspector.getByText(citation!.quote)).toBeInViewport();
  await expect(mobileReasonInput).toBeInViewport();
  await expect(mobileSubmit).toBeInViewport();
  await expect(
    viewer.getByText(
      "Stored byte integrity verified before rendering. This does not establish authenticity, admissibility, or safety.",
    ),
  ).toBeInViewport();
  await assertComparisonViewerVisualIntegrity(page);
  await page.screenshot({
    path: path.join(
      screenshotDir,
      "in-viewer-verification-mobile-393x1200.png",
    ),
  });

  await mobileSubmit.click();
  await expect(
    mobileInspector.getByTestId("original-comparison-verified"),
  ).toContainText("Text comparison recorded");
  expect(verificationRequests).toHaveLength(2);
  expect(verificationRequests[1]).toEqual({
    url: `${apiBase}/aletheia/matters/${state.matterId}/litigation/source-spans/${citation!.source_span_id}/verify-original`,
    body: { reason },
  });
  expect(verificationRequests[1].body).not.toHaveProperty("verified_by");
  const currentHistoryItem = mobileInspector.getByTestId(
    "original-verification-history-item-viewer-verification-fixture",
  );
  await expect(currentHistoryItem).toContainText("Current comparison");
  await expect(currentHistoryItem).toContainText("Current");
  await expect(currentHistoryItem).toContainText(
    "authenticated-actor-fixture",
  );
  await expect(currentHistoryItem).toContainText(reason);
  await expect(currentHistoryItem).toContainText("aaaaaaaa...aaaaaa");
  await expect(currentHistoryItem).toContainText("bbbbbbbb...bbbbbb");
  await viewer
    .getByRole("button", { name: "Close original inspector" })
    .click();
  await expect(viewer).toBeHidden();
  await expect(
    page.getByText("Compared with original scan · text match recorded").first(),
  ).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(
    page.getByText("Compared with original scan · text match recorded").first(),
  ).toBeVisible();
  const persistedInspect = page
    .getByRole("button", {
      name: new RegExp(
        `Inspect original ${citation!.document_name}.*recorded citation page`,
      ),
    })
    .first();
  await persistedInspect.click();
  await expect(
    viewer.getByTestId("original-comparison-verified"),
  ).toContainText("Actor provenance is assigned by the authenticated backend");
  await expect(viewer.getByLabel("Counsel comparison reason")).toHaveCount(0);

  await viewer.getByRole("button", { name: "Next page" }).click();
  await expect(viewer.getByLabel("PDF page position")).toHaveText("Page 3 / 3");
  const passiveDownload = page.waitForEvent("download");
  await viewer.getByRole("button", { name: "Save & open original" }).click();
  await passiveDownload;
  expect(withdrawalRequests).toHaveLength(0);
  expect(verificationRequests).toHaveLength(2);

  const withdrawalAction = viewer.getByRole("button", {
    name: "Withdraw or correct recorded comparison",
  });
  await withdrawalAction.click();
  const confirmation = viewer.getByTestId(
    "original-comparison-withdrawal-confirmation",
  );
  await expect(confirmation).toContainText(
    "The historical verification remains in the audit history.",
  );
  await expect(confirmation).toContainText(
    "reopens the low-confidence comparison gate",
  );
  const withdrawalReason = confirmation.getByLabel(
    "Reason for withdrawal or correction",
  );
  const confirmWithdrawal = confirmation.getByRole("button", {
    name: "Confirm withdrawal",
  });
  await withdrawalReason.fill("Too short");
  await expect(confirmWithdrawal).toBeDisabled();
  expect(withdrawalRequests).toHaveLength(0);
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  expect(withdrawalRequests).toHaveLength(0);

  await withdrawalAction.click();
  const correctionReason =
    "The recorded comparison used the wrong line; reopen the gate for a corrected page-level comparison.";
  await withdrawalReason.fill(correctionReason);
  const failedWithdrawalRequest = page.waitForRequest((request) =>
    request.url().endsWith("/viewer-verification-fixture/withdraw"),
  );
  await confirmWithdrawal.click();
  await failedWithdrawalRequest;
  await expect(
    confirmation.getByRole("button", { name: "Withdrawing comparison" }),
  ).toBeDisabled();
  await expect(withdrawalReason).toBeDisabled();
  await expect(
    confirmation.getByRole("button", { name: "Cancel" }),
  ).toBeDisabled();
  releaseFailedWithdrawal();
  await expect(confirmation.getByRole("alert")).toContainText(
    "could not be withdrawn",
  );
  await expect(withdrawalReason).toHaveValue(correctionReason);
  await expect(viewer).not.toContainText("/private/");
  expect(withdrawalRequests).toEqual([
    {
      url: `${apiBase}/aletheia/matters/${state.matterId}/litigation/source-spans/${citation!.source_span_id}/verifications/viewer-verification-fixture/withdraw`,
      body: { reason: correctionReason },
    },
  ]);
  await expect(confirmWithdrawal).toBeEnabled();
  await confirmation.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(
      withdrawalScreenshotDir,
      "source-verification-withdrawal-desktop-1440x1000.png",
    ),
  });

  await page.setViewportSize({ width: 393, height: 1200 });
  await confirmation.scrollIntoViewIfNeeded();
  await expect(withdrawalReason).toBeInViewport();
  await expect(confirmWithdrawal).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: path.join(
      withdrawalScreenshotDir,
      "source-verification-withdrawal-narrow-393x1200.png",
    ),
  });

  await confirmWithdrawal.click();
  await expect(viewer.getByTestId("original-comparison-verified")).toHaveCount(
    0,
  );
  await expect(viewer.getByLabel("Counsel comparison reason")).toBeVisible();
  await expect(
    viewer.getByRole("button", { name: "Record text comparison" }),
  ).toBeDisabled();
  expect(persistedVerificationId).toBeNull();
  const withdrawnHistoryItem = viewer.getByTestId(
    "original-verification-history-item-viewer-verification-fixture",
  );
  await expect(withdrawnHistoryItem).toContainText("Withdrawn comparison");
  await expect(withdrawnHistoryItem).toContainText("Withdrawn");
  await expect(withdrawnHistoryItem).toContainText(correctionReason);
  await expect(withdrawnHistoryItem).toContainText(
    "authenticated-actor-fixture",
  );
  expect(withdrawalRequests).toEqual([
    {
      url: `${apiBase}/aletheia/matters/${state.matterId}/litigation/source-spans/${citation!.source_span_id}/verifications/viewer-verification-fixture/withdraw`,
      body: { reason: correctionReason },
    },
    {
      url: `${apiBase}/aletheia/matters/${state.matterId}/litigation/source-spans/${citation!.source_span_id}/verifications/viewer-verification-fixture/withdraw`,
      body: { reason: correctionReason },
    },
  ]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await withdrawnHistoryItem.scrollIntoViewIfNeeded();
  await assertComparisonViewerVisualIntegrity(page);
  await page.screenshot({
    path: path.join(
      historyScreenshotDir,
      "source-verification-history-withdrawn-1440x1000.png",
    ),
  });
  await page.setViewportSize({ width: 393, height: 1200 });
  await withdrawnHistoryItem.scrollIntoViewIfNeeded();
  await expect(withdrawnHistoryItem).toBeInViewport();
  await assertComparisonViewerVisualIntegrity(page);
  await page.screenshot({
    path: path.join(
      historyScreenshotDir,
      "source-verification-history-withdrawn-393x1200.png",
    ),
  });
  await viewer
    .getByRole("button", { name: "Close original inspector" })
    .click();
  await expect(viewer).toBeHidden();
  await expect(
    page.getByText("Original scan comparison required").first(),
  ).toBeVisible();

  recordedPage = 99;
  await page.reload();
  await expect(persistedInspect).toBeVisible();
  await persistedInspect.click();
  await expect(viewer.getByRole("alert")).toContainText(
    "Recorded page 99 is outside this 3-page PDF. Nothing was displayed.",
  );
  await expect(viewer.getByTestId("original-evidence-canvas")).toHaveCSS(
    "visibility",
    "hidden",
  );
  await viewer
    .getByRole("button", { name: "Close original inspector" })
    .click();

  const afterResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${state.matterId}`,
  );
  const after = (await afterResponse.json()) as {
    auditEvents: Array<{ action: string }>;
  };
  expect(
    after.auditEvents.filter(
      (event) => event.action === "litigation_source_original_scan_verified",
    ),
  ).toHaveLength(beforeComparisons);
});

test("civil litigation workspace keeps proposals reviewable and source linked", async ({
  page,
}, testInfo) => {
  const state = fixture(testInfo.project.name);
  await page.addInitScript(() => {
    Object.defineProperty(window, "aletheiaDesktop", {
      configurable: true,
      value: {
        saveOriginalMatterDocument: async () => ({
          saved: true,
          canceled: false,
          opened: true,
        }),
      },
    });
  });
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(state.matterUrl);
  await expect(
    page.getByRole("heading", { name: state.matterTitle }),
  ).toBeVisible();
  await expect(page.getByText("5 项待复核")).toBeVisible();
  await expect(
    page.getByText("已确认事实", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "事实与证据" }).click();
  await expect(
    page.getByRole("heading", { name: "Fact timeline" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "The disputed payment was contractually due on 1 September 2026.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("争议款项约定付款日为2026年9月1日"),
  ).toBeVisible();
  const paymentFact = page.locator("article").filter({
    hasText: "The disputed payment was contractually due on 1 September 2026.",
  });
  await expect(paymentFact).toContainText("OCR page 1 · confidence 55%");
  await expect(paymentFact).toContainText("Original scan comparison required");
  const originalCommand = paymentFact.getByRole("button", {
    name: /Save and open original.*recorded citation page 1/,
  });
  await originalCommand.click();
  await expect(paymentFact.getByRole("status")).toContainText(
    "saved and opened",
  );
  await expect(paymentFact.getByRole("status")).toContainText(
    "external viewer may open elsewhere",
  );
  const beforeComparisonResponse = await page.request.get(
    `http://127.0.0.1:${state.backendPort}/aletheia/matters/${state.matterId}`,
  );
  const beforeComparison = (await beforeComparisonResponse.json()) as {
    auditEvents: Array<{ action: string }>;
  };
  expect(
    beforeComparison.auditEvents.filter(
      (event) => event.action === "litigation_source_original_scan_verified",
    ),
  ).toHaveLength(0);
  await paymentFact.getByText("Original scan comparison required").click();
  await paymentFact
    .getByPlaceholder("Record what you compared with the original scan.")
    .fill("Compared the payment date and wording with the original scan.");
  await paymentFact.getByRole("button", { name: "Record comparison" }).click();
  await expect(paymentFact).toContainText(
    "Compared with original scan · text match recorded",
  );
  await paymentFact.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("4 项待复核")).toBeVisible();

  await page.getByRole("button", { name: "请求权与抗辩" }).click();
  const claimRow = page.locator("article").filter({
    hasText: "The payment obligation was not due when the action was filed.",
  });
  await expect(claimRow).toContainText("Agreed payment due date");
  await expect(claimRow).toContainText("Supported");
  await expect(claimRow).toContainText(
    "The disputed payment was contractually due on 1 September 2026.",
  );
  await expect(claimRow).toContainText("OCR page 1 · confidence 55%");
  await claimRow.getByText("Original scan comparison required").click();
  await claimRow
    .getByPlaceholder("Record what you compared with the original scan.")
    .fill("Compared the cited payment date with the original scanned record.");
  await claimRow.getByRole("button", { name: "Record comparison" }).click();
  await expect(claimRow).toContainText(
    "Compared with original scan · text match recorded",
  );
  const matterResponse = await page.request.get(
    `http://127.0.0.1:${state.backendPort}/aletheia/matters/${state.matterId}`,
  );
  expect(matterResponse.ok()).toBe(true);
  const matterDetail = (await matterResponse.json()) as {
    auditEvents: Array<{ action: string }>;
  };
  expect(
    matterDetail.auditEvents.filter(
      (event) => event.action === "litigation_source_original_scan_verified",
    ),
  ).toHaveLength(2);
  await claimRow.getByRole("button", { name: "Confirm" }).first().click();
  await expect(page.getByText("3 项待复核")).toBeVisible();
  await claimRow.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("2 项待复核")).toBeVisible();

  const apiBase = `http://127.0.0.1:${state.backendPort}`;
  const confirmedWorkspaceResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${state.matterId}/litigation`,
  );
  const confirmedWorkspace = (await confirmedWorkspaceResponse.json()) as {
    claims: Array<{ id: string; title: string; status: string }>;
  };
  const confirmedDefense = confirmedWorkspace.claims.find(
    (claim) =>
      claim.title ===
        "The payment obligation was not due when the action was filed." &&
      claim.status === "confirmed",
  );
  expect(confirmedDefense).toBeTruthy();
  const governingQuote =
    "A payment obligation becomes due on the date fixed by the parties' agreement.";
  const authorityWrite = await page.request.post(
    `${apiBase}/aletheia/matters/${state.matterId}/litigation/legal-authorities`,
    {
      data: {
        authorityType: "statute",
        title: "Civil Payment Timing Act",
        issuer: "National Legislature",
        officialIdentifier: `SOL-BASELINE-${testInfo.project.name}`,
        versionLabel: "2026 official text",
        sourceReference: "Official Gazette 2026, payment timing edition",
        content: `${governingQuote} The date must be established from the executed agreement.`,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      },
    },
  );
  expect(authorityWrite.status()).toBe(201);
  const governingAuthority = (await authorityWrite.json()) as { id: string };
  const authorityVerify = await page.request.post(
    `${apiBase}/aletheia/matters/${state.matterId}/litigation/legal-authorities/${governingAuthority.id}/verify`,
    {
      data: {
        comment:
          "Counsel checked the stored text against the cited official Gazette edition.",
      },
    },
  );
  expect(authorityVerify.ok()).toBe(true);
  const authorityLink = await page.request.post(
    `${apiBase}/aletheia/matters/${state.matterId}/litigation/position-authorities`,
    {
      data: {
        claimId: confirmedDefense!.id,
        authorityVersionId: governingAuthority.id,
        applicabilityDate: "2026-09-01",
        provisionReference: "Payment due date rule",
        exactQuote: governingQuote,
        rationale:
          "The rule governs whether the payment obligation was due on the pleaded filing date.",
      },
    },
  );
  expect(authorityLink.status()).toBe(201);

  await page.getByRole("button", { name: "程序与期限" }).click();
  const eventRow = page
    .locator("article")
    .filter({ hasText: "Court hearing notice received" });
  await expect(eventRow).toContainText("2026年8月10日上午9时");
  await eventRow.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("1 项待复核")).toBeVisible();
  const deadlineRow = page
    .locator("article")
    .filter({ hasText: "Complete internal evidence review" });
  await expect(deadlineRow).toContainText("2026年8月10日上午9时");
  await deadlineRow.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("0 项待复核")).toBeVisible();

  await page.getByRole("button", { name: "概览" }).click();
  await expect(
    page.getByText("已确认请求权/抗辩", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("近期已确认期限", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Complete internal evidence review"),
  ).toBeVisible();

  await page.getByRole("button", { name: "文书与庭审" }).click();
  await page
    .getByPlaceholder("Firm or organization")
    .fill("Aletheia Trial Team");
  await page.getByPlaceholder("Court").fill("Shanghai Commercial Court");
  await page.getByPlaceholder("Case number").fill("2026-CIV-001");
  await page.getByLabel("Exhibit prefix").fill("DEF");
  await page.getByLabel("Exhibit start").fill("12");
  await page
    .getByLabel("Bundle pagination policy")
    .selectOption("source_native");
  await expect(page.getByLabel("Document template")).toHaveValue(
    "cn-litigation-working-paper:1",
  );
  await expect(page.getByLabel("Template name")).toBeVisible();
  await expect(page.getByLabel("DOCX template file")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import draft" }),
  ).toBeDisabled();
  await expect(page.getByText("No firm templates imported.")).toBeVisible();
  await page
    .getByRole("button", { name: "Save document and bundle profile" })
    .click();
  const matrixArtifact = page
    .locator("article")
    .filter({ hasText: "Claim and defense matrix" });
  await matrixArtifact.getByRole("button", { name: "Generate" }).click();
  await expect(matrixArtifact).toContainText("v1");
  await expect(matrixArtifact).toContainText("verified sources");
  await matrixArtifact
    .getByRole("button", { name: "Create new version" })
    .click();
  await expect(matrixArtifact).toContainText("v2");
  await expect(matrixArtifact).toContainText("no material section changes");
  const bundleIndexArtifact = page
    .locator("article")
    .filter({ hasText: "Hearing bundle index" });
  await bundleIndexArtifact.getByRole("button", { name: "Generate" }).click();
  await expect(bundleIndexArtifact).toContainText("v1");
  await expect(bundleIndexArtifact).toContainText("0 open validation items");
  await expect(bundleIndexArtifact).toContainText(
    "Source-native pagination; continuous page map unavailable",
  );
  await expect(
    bundleIndexArtifact.getByRole("button", {
      name: "Request export approval",
    }),
  ).toBeVisible();
  await bundleIndexArtifact
    .getByRole("button", { name: "Request export approval" })
    .click();
  await bundleIndexArtifact
    .getByRole("button", { name: "Approve locally" })
    .click();
  await bundleIndexArtifact
    .getByRole("button", { name: "Export approved bundle" })
    .click();
  await expect(
    bundleIndexArtifact.getByText("Exported bundle ready"),
  ).toBeVisible();
  const bundleDownloadPromise = page.waitForEvent("download");
  await bundleIndexArtifact
    .getByRole("button", { name: "Save bundle" })
    .click();
  const bundleDownload = await bundleDownloadPromise;
  expect(bundleDownload.suggestedFilename()).toMatch(/\.zip$/);
  const bundleDownloadPath = await bundleDownload.path();
  expect(bundleDownloadPath).not.toBeNull();
  const bundleBytes = readFileSync(bundleDownloadPath!);
  expect(bundleBytes.subarray(0, 2).toString("ascii")).toBe("PK");
  const bundleListing = execFileSync("unzip", ["-Z1", bundleDownloadPath!], {
    encoding: "utf8",
  });
  expect(bundleListing).toContain("manifest.json");
  expect(bundleListing).toContain("hearing-bundle-index.docx");
  expect(bundleListing).toContain("exhibits/DEF-012-");
  const bundleManifest = JSON.parse(
    execFileSync("unzip", ["-p", bundleDownloadPath!, "manifest.json"], {
      encoding: "utf8",
    }),
  ) as {
    pagination: { mode: string; totalPages: number | null };
    entries: Array<{
      pageCount: number | null;
      bundlePageStart: number | null;
      bundlePageEnd: number | null;
    }>;
  };
  expect(bundleManifest.pagination.mode).toBe("source_native_only");
  expect(bundleManifest.pagination.totalPages).toBeNull();
  expect(
    bundleManifest.entries.every((entry) => entry.pageCount === null),
  ).toBe(true);
  await page.getByLabel("Exhibit prefix").fill("TRIAL");
  await page
    .getByRole("button", { name: "Save document and bundle profile" })
    .click();
  await expect(bundleIndexArtifact).toContainText("Stale");
  const briefArtifact = page.locator("article").filter({
    has: page.getByRole("heading", {
      name: "Litigation brief",
      exact: true,
    }),
  });
  await briefArtifact.getByRole("button", { name: "Generate" }).click();
  await expect(briefArtifact).toContainText("v1");
  await briefArtifact
    .getByRole("button", { name: "Request export approval" })
    .click();
  await briefArtifact.getByRole("button", { name: "Approve locally" }).click();
  await briefArtifact
    .getByRole("button", { name: "Export approved DOCX" })
    .click();
  const exportStatus = briefArtifact.getByText("Exported DOCX ready");
  await expect(exportStatus).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await briefArtifact.getByRole("button", { name: "Save DOCX" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect(readFileSync(downloadPath!).subarray(0, 2).toString("ascii")).toBe(
    "PK",
  );

  await page.getByRole("button", { name: "请求权与抗辩" }).click();
  await page
    .getByPlaceholder("Describe the position.")
    .fill("The claimant failed to mitigate the alleged loss.");
  await page
    .getByPlaceholder("Legal basis or governing rule")
    .fill("Loss mitigation defense for counsel review.");
  await page.getByRole("button", { name: "Add proposal" }).click();
  const newClaim = page
    .locator("article")
    .filter({ hasText: "The claimant failed to mitigate the alleged loss." });
  await newClaim.getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("button", { name: "文书与庭审" }).click();
  await expect(matrixArtifact).toContainText("Stale");
  await expect(briefArtifact).toContainText("Stale");
  await expect(
    briefArtifact.getByRole("button", { name: "Request export approval" }),
  ).toHaveCount(0);
  await matrixArtifact.getByRole("button", { name: "Regenerate" }).click();
  await expect(matrixArtifact).toContainText("v3");
  await expect(matrixArtifact).not.toContainText("Stale");

  await page.getByRole("button", { name: "请求权与抗辩" }).click();
  await page.getByLabel("Reviewed position").selectOption({
    label: "The payment obligation was not due when the action was filed.",
  });
  await page
    .getByPlaceholder(
      "State the error, missing source, or changed circumstance.",
    )
    .fill(
      "The current position does not address the claimant's filing-date argument.",
    );
  await page.getByRole("button", { name: "Submit review" }).click();
  const reviewedClaim = page.locator("article").filter({
    hasText: "The payment obligation was not due when the action was filed.",
  });
  await expect(reviewedClaim).toContainText("Review open · objection");
  await expect(page.getByText("1 项待复核")).toBeVisible();
  if (process.env.ALETHEIA_CAPTURE_LITIGATION === "true") {
    await reviewedClaim.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.screenshot({
      path: `/tmp/aletheia-${testInfo.project.name}-position-review.png`,
      fullPage: true,
    });
  }

  await page.getByRole("button", { name: "文书与庭审" }).click();
  await expect(matrixArtifact).toContainText("Stale");
  await matrixArtifact.getByRole("button", { name: "Regenerate" }).click();
  await expect(matrixArtifact).toContainText("v4");
  await expect(matrixArtifact).toContainText(
    "Final export blocked: 1 open position review.",
  );
  await expect(
    matrixArtifact.getByRole("button", { name: "Request export approval" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "请求权与抗辩" }).click();
  await page.getByLabel("Open position review").selectOption({ index: 1 });
  await page.getByLabel("Review resolution").selectOption("granted");
  await page
    .getByPlaceholder("Record the reviewer’s reasons.")
    .fill("The objection is granted pending a revised source-backed position.");
  await page.getByRole("button", { name: "Record resolution" }).click();
  await expect(reviewedClaim).not.toContainText("Review open");
  await expect(reviewedClaim).toContainText("rejected");
  await expect(reviewedClaim).toContainText("Assessment v2");
  await reviewedClaim.getByText("View 2 versions").click();
  await expect(reviewedClaim).toContainText("v1 · confirmed");
  await expect(reviewedClaim).toContainText("v2 · rejected");
  await expect(page.getByText("0 项待复核")).toBeVisible();
  await page.getByLabel("Review level").selectOption({ index: 1 });
  await expect(
    page.getByText(
      "Level 2 internal review. This local single-user decision is not independently reviewed.",
    ),
  ).toBeVisible();
  await page
    .getByPlaceholder(
      "State the error, missing source, or changed circumstance.",
    )
    .fill("Escalate the revised position for second-level internal review.");
  await page.getByRole("button", { name: "Submit review" }).click();
  await expect(reviewedClaim).toContainText(
    "Level 2 internal appeal open · not independent",
  );
  await expect(page.getByText("1 项待复核")).toBeVisible();
  await page.getByLabel("Open position review").selectOption({ index: 1 });
  await page.getByLabel("Review resolution").selectOption("upheld");
  await page
    .getByPlaceholder("Record the reviewer’s reasons.")
    .fill("Second-level review upholds the revised position.");
  await page.getByRole("button", { name: "Record resolution" }).click();
  await expect(reviewedClaim).not.toContainText("appeal open");
  await expect(reviewedClaim).toContainText("Level 2 review · not independent");
  await expect(page.getByText("0 项待复核")).toBeVisible();
  await page.getByRole("button", { name: "文书与庭审" }).click();
  await expect(matrixArtifact).toContainText("Stale");

  if (process.env.ALETHEIA_CAPTURE_LITIGATION === "true") {
    await page
      .getByRole("heading", { name: "Documents and hearing preparation" })
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.screenshot({
      path: `/tmp/aletheia-${testInfo.project.name}-artifacts.png`,
    });
  }

  await page.goto(`${state.matterUrl}?view=agent`);
  await expect(page.getByText("Local executor unavailable")).toBeVisible();
  await expect(
    page.getByText(
      "No cloud fallback is used and no simulated run is created.",
    ),
  ).toBeVisible();

  await page.goto(`${state.matterUrl}?view=evals`);
  await page.getByRole("button", { name: "Run deterministic suite" }).click();
  await expect(page.getByText("15/17")).toBeVisible();
  const missingCitationCase = page
    .getByText("missing citation badcase")
    .locator("..")
    .locator("..");
  await expect(missingCitationCase).toContainText("FAIL");
  const missingAuthorityCase = page
    .getByText("missing verified legal authority badcase")
    .locator("..")
    .locator("..");
  await expect(missingAuthorityCase).toContainText("FAIL");
  await expect(page.getByText("approval bypass badcase")).toBeVisible();
  await expect(
    page.getByText("unconfirmed element projection badcase"),
  ).toBeVisible();
  await expect(page.getByText("stale artifact export badcase")).toBeVisible();
  await expect(
    page.getByText("legal assessment lineage integrity"),
  ).toBeVisible();
  await expect(page.getByText("open review projection badcase")).toBeVisible();
  await expect(
    page.getByText("independent review actor separation"),
  ).toBeVisible();
  await expect(
    page.getByText("hearing bundle pagination integrity"),
  ).toBeVisible();
  await expect(page.getByText("grounded agent run integrity")).toBeVisible();
  await expect(
    page.getByText("agent output review binding badcase"),
  ).toBeVisible();
  await expect(
    page.getByText("adopted finding support review badcase"),
  ).toBeVisible();
  if (process.env.ALETHEIA_CAPTURE_LITIGATION === "true") {
    await page
      .getByRole("heading", { name: "Litigation Eval Lab" })
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.screenshot({
      path: `/tmp/aletheia-${testInfo.project.name}-evals.png`,
    });
  }

  const bodyOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(bodyOverflow).toBe(false);
  expect(errors).toEqual([]);
});

test("counsel enforces position authority readiness before Agent, approval, and export", async ({
  page,
}, testInfo) => {
  const state = fixture(testInfo.project.name);
  const isMobile = testInfo.project.name === "mobile-chromium";
  const apiBase = `http://127.0.0.1:${state.backendPort}`;
  const matterWrite = await page.request.post(`${apiBase}/aletheia/matters`, {
    data: {
      title: `Position authority readiness ${testInfo.project.name}`,
      template: "civil_litigation",
      objective:
        "Verify exact-quote legal authority gates across position decisions, Agent input, documents, approval, and export.",
      status: "in_progress",
    },
  });
  expect(matterWrite.status()).toBe(201);
  const matter = (await matterWrite.json()) as { id: string };
  const matterId = matter.id;
  const matterUrl = `/aletheia/matters/${matterId}/litigation`;
  const dossierQuote =
    "The executed contract records that payment became due on 15 August 2026 after delivery was accepted.";
  const authorityQuote =
    "Section 27 requires payment within the period fixed by an executed contract.";
  const authorityText = `${authorityQuote} Section 28 requires written notice before default remedies are sought.`;
  const linkPayload = (
    claimId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    claimId,
    authorityVersionId: authority.id,
    applicabilityDate: "2026-08-15",
    provisionReference: "Section 27 readiness",
    exactQuote: authorityQuote,
    rationale:
      "The verified provision governs the contractual payment date recorded in the cited matter source.",
    ...overrides,
  });

  await page.setViewportSize(
    isMobile ? { width: 393, height: 852 } : { width: 1440, height: 1000 },
  );
  await page.goto(`${matterUrl}?view=facts`);
  await page.getByTestId("matter-document-files-input").setInputFiles({
    name: "executed-payment-record.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(dossierQuote),
  });
  await expect(page.getByText("1 indexed", { exact: true })).toBeVisible();
  await page.goto(`${matterUrl}?view=positions`);

  const createPosition = async (title: string) => {
    await page.getByPlaceholder("Describe the position.").fill(title);
    await page
      .getByPlaceholder("Legal basis or governing rule")
      .fill("Contract payment duty under the governing civil law.");
    await page.getByLabel("Position confidence").selectOption("high");
    await page.getByLabel("Source record").selectOption({ index: 1 });
    await page.getByLabel("Exact source quote").fill(dossierQuote);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/matters/${matterId}/litigation/claims`),
    );
    await page.getByRole("button", { name: "Add proposal" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    return (await response.json()) as { id: string; title: string };
  };

  const missingPosition = await createPosition(
    "Payment was due on 15 August 2026 under the executed contract.",
  );
  const missingRow = page.getByTestId(`claim-${missingPosition.id}`);
  await expect(
    missingRow.getByTestId(
      `position-authority-readiness-${missingPosition.id}`,
    ),
  ).toContainText("Authority basis missing");
  await expect(missingRow).toContainText(
    "Counsel may still record a position decision",
  );
  await expect(missingRow).toContainText(
    "cannot enter Agent snapshots, approval-ready documents, or export",
  );

  const authoritySection = page
    .getByRole("heading", { name: "Legal authority versions" })
    .locator("xpath=ancestor::section[1]");
  await authoritySection.getByRole("button", { name: "New version" }).click();
  await authoritySection.getByLabel("Authority type").selectOption("statute");
  await authoritySection
    .getByLabel("Title")
    .fill("Contractual Payment Performance Act");
  await authoritySection.getByLabel("Issuer").fill("National Legislature");
  await authoritySection
    .getByLabel("Official identifier")
    .fill(`SOL-POSITION-${testInfo.project.name}`);
  await authoritySection.getByLabel("Version label").fill("2026 official text");
  await authoritySection
    .getByLabel("Named source reference")
    .fill("Official Gazette 2026, issue 27");
  await authoritySection.getByLabel("Effective from").fill("2026-01-01");
  await authoritySection
    .getByLabel("Effective to (optional)")
    .fill("2026-12-31");
  await authoritySection
    .getByLabel("Full stored source text")
    .fill(authorityText);
  const authorityCreatePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(`/matters/${matterId}/litigation/legal-authorities`),
  );
  await authoritySection.getByRole("button", { name: "Create draft" }).click();
  const authorityCreate = await authorityCreatePromise;
  expect(authorityCreate.status()).toBe(201);
  const authority = (await authorityCreate.json()) as {
    id: string;
    content_sha256: string;
  };

  const draftLink = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/position-authorities`,
    { data: linkPayload(missingPosition.id) },
  );
  expect(draftLink.status()).toBe(400);
  expect(await draftLink.json()).toMatchObject({
    detail: expect.stringContaining("must be verified and matter-scoped"),
  });
  const shortVerification = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/legal-authorities/${authority.id}/verify`,
    { data: { comment: "checked" } },
  );
  expect(shortVerification.status()).toBe(400);
  expect(await shortVerification.json()).toMatchObject({
    detail: expect.stringContaining("10-2000 character source-check comment"),
  });

  const verificationReason =
    "Counsel compared the full stored text with Official Gazette 2026, issue 27.";
  await authoritySection
    .getByLabel("Counsel verification reason")
    .fill(verificationReason);
  await authoritySection
    .getByRole("button", { name: "Verify version" })
    .click();
  await expect(
    authoritySection.getByText("verified", { exact: true }).first(),
  ).toBeVisible();
  await authoritySection
    .getByLabel("Position for authority")
    .selectOption(missingPosition.id);
  const missingSelectorReadiness = authoritySection.getByTestId(
    `authority-selector-readiness-${missingPosition.id}`,
  );
  await expect(missingSelectorReadiness).toContainText(
    "Authority basis missing · position proposed",
  );

  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-12-position-authority-readiness",
  );
  mkdirSync(screenshotDir, { recursive: true });
  const alignBelowShellHeader = async (locator: Locator) => {
    await locator.scrollIntoViewIfNeeded();
    await locator.evaluate((element) => {
      let parent = element.parentElement;
      while (parent) {
        if (/(auto|scroll)/.test(window.getComputedStyle(parent).overflowY)) {
          const offset =
            element.getBoundingClientRect().top -
            parent.getBoundingClientRect().top;
          parent.scrollTop += offset - 12;
          return;
        }
        parent = parent.parentElement;
      }
    });
    await page.waitForTimeout(120);
  };
  const assertLayout = async () => {
    const audit = await page.evaluate(() => {
      const paintedRect = (element: HTMLElement) => {
        const source = element.getBoundingClientRect();
        let left = Math.max(0, source.left);
        let right = Math.min(window.innerWidth, source.right);
        let top = Math.max(0, source.top);
        let bottom = Math.min(window.innerHeight, source.bottom);
        let parent = element.parentElement;
        while (parent) {
          const style = window.getComputedStyle(parent);
          const rect = parent.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
            left = Math.max(left, rect.left);
            right = Math.min(right, rect.right);
          }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            top = Math.max(top, rect.top);
            bottom = Math.min(bottom, rect.bottom);
          }
          parent = parent.parentElement;
        }
        return {
          left,
          right,
          top,
          bottom,
          width: right - left,
          height: bottom - top,
        };
      };
      const visible = (element: HTMLElement) => {
        const style = window.getComputedStyle(element);
        const rect = paintedRect(element);
        if (!(
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight
        )) {
          return false;
        }
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(centerX, centerY);
        return Boolean(hit && (hit === element || element.contains(hit)));
      };
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button, input, select, textarea",
        ),
      ).filter(visible);
      const clipped = controls
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left < -1 || rect.right > window.innerWidth + 1;
        })
        .map(
          (element) =>
            element.getAttribute("aria-label") ||
            element.textContent?.trim() ||
            element.tagName,
        );
      const overlaps: string[] = [];
      for (let index = 0; index < controls.length; index += 1) {
        const left = controls[index];
        const leftRect = paintedRect(left);
        for (
          let candidate = index + 1;
          candidate < controls.length;
          candidate += 1
        ) {
          const right = controls[candidate];
          if (left.contains(right) || right.contains(left)) continue;
          const rightRect = paintedRect(right);
          const width =
            Math.min(leftRect.right, rightRect.right) -
            Math.max(leftRect.left, rightRect.left);
          const height =
            Math.min(leftRect.bottom, rightRect.bottom) -
            Math.max(leftRect.top, rightRect.top);
          if (width > 1 && height > 1) {
            const describe = (element: HTMLElement) =>
              element.getAttribute("aria-label") ||
              element.getAttribute("title") ||
              element.textContent?.trim().slice(0, 60) ||
              element.tagName;
            overlaps.push(
              `${left.tagName}[${describe(left)}]:${right.tagName}[${describe(right)}]`,
            );
          }
        }
      }
      const header = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".aletheia-shell > div > header",
        ),
      ).find((element) => window.getComputedStyle(element).display !== "none");
      const scroller = document.querySelector<HTMLElement>(
        ".aletheia-shell > div > main.overflow-y-auto",
      );
      return {
        documentOverflow:
          document.documentElement.scrollWidth - window.innerWidth,
        headerOverlap:
          header && scroller
            ? header.getBoundingClientRect().bottom -
              scroller.getBoundingClientRect().top
            : null,
        clipped,
        overlaps,
      };
    });
    expect(audit.documentOverflow).toBeLessThanOrEqual(1);
    expect(audit.headerOverlap).not.toBeNull();
    expect(audit.headerOverlap!).toBeLessThanOrEqual(1);
    expect(audit.clipped).toEqual([]);
    expect(audit.overlaps).toEqual([]);
  };
  if (!isMobile) {
    await alignBelowShellHeader(missingSelectorReadiness);
    await assertLayout();
    await page.screenshot({
      path: path.join(
        screenshotDir,
        "01-missing-gate-proposed-selector-1440x1000.png",
      ),
      animations: "disabled",
      scale: "css",
    });
  }

  const tamperedQuote = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/position-authorities`,
    {
      data: linkPayload(missingPosition.id, {
        exactQuote: `${authorityQuote} altered`,
      }),
    },
  );
  expect(tamperedQuote.status()).toBe(400);
  expect(await tamperedQuote.json()).toMatchObject({
    detail: expect.stringContaining(
      "must match the stored source text exactly",
    ),
  });
  const outOfPeriod = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/position-authorities`,
    {
      data: linkPayload(missingPosition.id, {
        applicabilityDate: "2027-01-01",
      }),
    },
  );
  expect(outOfPeriod.status()).toBe(400);
  expect(await outOfPeriod.json()).toMatchObject({
    detail: expect.stringContaining("was not effective"),
  });
  const shortRationale = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/position-authorities`,
    { data: linkPayload(missingPosition.id, { rationale: "Too short" }) },
  );
  expect(shortRationale.status()).toBe(400);
  expect(await shortRationale.json()).toMatchObject({
    detail: expect.stringContaining("10-2000 character rationale"),
  });
  const otherMatterWrite = await page.request.post(
    `${apiBase}/aletheia/matters`,
    {
      data: {
        title: `Cross-matter authority probe ${testInfo.project.name}`,
        template: "civil_litigation",
        objective: "Prove position authority links remain matter-scoped.",
      },
    },
  );
  const otherMatter = (await otherMatterWrite.json()) as { id: string };
  const otherClaimWrite = await page.request.post(
    `${apiBase}/aletheia/matters/${otherMatter.id}/litigation/claims`,
    {
      data: {
        kind: "claim",
        title: "Cross-matter position must not bind.",
        legalBasis: "Matter isolation test.",
        confidence: "medium",
        sourceRelation: "authority",
        source: null,
      },
    },
  );
  const otherClaim = (await otherClaimWrite.json()) as { id: string };
  const crossMatter = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/position-authorities`,
    { data: linkPayload(otherClaim.id) },
  );
  expect(crossMatter.status()).toBe(400);
  expect(await crossMatter.json()).toMatchObject({
    detail: expect.stringContaining("in this matter"),
  });

  await missingRow.getByRole("button", { name: "Confirm" }).click();
  await expect(missingRow).toContainText("confirmed");
  const blockedArtifactResponse = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/artifacts/litigation_brief`,
  );
  expect(blockedArtifactResponse.status()).toBe(201);
  const blockedArtifact = (await blockedArtifactResponse.json()) as {
    validation_errors: Array<{ code: string; claimId?: string }>;
  };
  expect(blockedArtifact.validation_errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "verified_legal_authority_missing",
        claimId: missingPosition.id,
      }),
    ]),
  );

  const inspectSnapshot = () => {
    const backendDir = path.resolve(process.cwd(), "..", "backend");
    const script = `
      import { LocalAletheiaRepository } from "./src/lib/aletheia/localRepository";
      async function main() {
        const repository = new LocalAletheiaRepository();
        const snapshot = await repository.prepareLitigationAgentSnapshot(
          { userId: "local-user" },
          process.env.POSITION_AUTHORITY_MATTER_ID!,
        ) as Record<string, any>;
        const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
        process.stdout.write("POSITION_SNAPSHOT_JSON=" + JSON.stringify({
          positionIds: positions.map((position: Record<string, any>) => String(position.id)),
          authorityCounts: Object.fromEntries(positions.map((position: Record<string, any>) => [
            String(position.id),
            Array.isArray(position.legalAuthorities) ? position.legalAuthorities.length : 0,
          ])),
        }));
      }
      void main().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const output = execFileSync(
      path.join(backendDir, "node_modules", ".bin", "tsx"),
      ["-e", script],
      {
        cwd: backendDir,
        env: {
          ...process.env,
          ALETHEIA_DATA_DIR: state.dataDir,
          POSITION_AUTHORITY_MATTER_ID: matterId,
        },
        encoding: "utf8",
      },
    );
    const marker = "POSITION_SNAPSHOT_JSON=";
    const markerIndex = output.lastIndexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    return JSON.parse(output.slice(markerIndex + marker.length)) as {
      positionIds: string[];
      authorityCounts: Record<string, number>;
    };
  };
  expect(inspectSnapshot().positionIds).not.toContain(missingPosition.id);

  const readyPosition = await createPosition(
    "The verified payment rule applies to the accepted delivery record.",
  );
  await authoritySection
    .getByLabel("Position for authority")
    .selectOption(readyPosition.id);
  await expect(
    authoritySection
      .getByLabel("Position for authority")
      .locator("option:checked"),
  ).toContainText("proposed · authority missing");
  await authoritySection.getByLabel("Applicability date").fill("2026-08-15");
  await authoritySection
    .getByLabel("Provision reference")
    .fill("Section 27 readiness");
  await authoritySection
    .getByLabel("Exact authority quote")
    .fill(authorityQuote);
  await authoritySection
    .getByLabel("Authority applicability rationale")
    .fill(
      "The verified provision governs the contractual payment date recorded in the cited matter source.",
    );
  const readyLinkPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/litigation/position-authorities"),
  );
  await authoritySection
    .getByRole("button", { name: "Link authority" })
    .click();
  const readyLinkResponse = await readyLinkPromise;
  expect(readyLinkResponse.status()).toBe(201);
  const readyLink = (await readyLinkResponse.json()) as { id: string };
  await expect(
    page.getByTestId(`position-authority-readiness-${readyPosition.id}`),
  ).toContainText("Authority basis satisfied");
  await expect(
    authoritySection.getByTestId(
      `authority-selector-readiness-${readyPosition.id}`,
    ),
  ).toContainText("position proposed");

  const restoreMissingGate = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/position-authorities`,
    {
      data: linkPayload(missingPosition.id, {
        provisionReference: "Section 27 gate probe",
      }),
    },
  );
  expect(restoreMissingGate.status()).toBe(201);
  await page.reload();
  const readyRow = page.getByTestId(`claim-${readyPosition.id}`);
  await readyRow.getByRole("button", { name: "Confirm" }).click();
  await expect(readyRow).toContainText("confirmed");

  const currentWorkspaceResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${matterId}/litigation`,
  );
  const currentWorkspace = (await currentWorkspaceResponse.json()) as {
    legal_assessments: Array<{
      claim_id: string;
      source_snapshot: unknown;
    }>;
  };
  const readyAssessment = currentWorkspace.legal_assessments.find(
    (assessment) => assessment.claim_id === readyPosition.id,
  );
  expect(readyAssessment?.source_snapshot).toMatchObject({
    evidenceSources: expect.any(Array),
    legalAuthorities: [
      expect.objectContaining({
        authority_version_id: authority.id,
        rationale: expect.stringContaining("contractual payment date"),
        content_sha256: authority.content_sha256,
        effective_from: "2026-01-01",
        effective_to: "2026-12-31",
      }),
    ],
  });

  const eligibleArtifactResponse = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/artifacts/litigation_brief`,
  );
  expect(eligibleArtifactResponse.status()).toBe(201);
  const eligibleArtifact = (await eligibleArtifactResponse.json()) as {
    id: string;
    validation_errors: Array<{ code: string }>;
    content: { issues?: Array<{ id: string; legalAuthorities?: unknown[] }> };
  };
  expect(
    eligibleArtifact.validation_errors.some(
      (item) => item.code === "verified_legal_authority_missing",
    ),
  ).toBe(false);
  const artifactReadyPosition = eligibleArtifact.content.issues?.find(
    (position) => position.id === readyPosition.id,
  );
  expect(artifactReadyPosition?.legalAuthorities?.length).toBeGreaterThan(0);
  const eligibleSnapshot = inspectSnapshot();
  expect(eligibleSnapshot.positionIds).toContain(readyPosition.id);
  expect(eligibleSnapshot.authorityCounts[readyPosition.id]).toBeGreaterThan(0);

  await page.reload();
  await authoritySection
    .getByLabel("Position for authority")
    .selectOption(readyPosition.id);
  const satisfiedReadiness = authoritySection.getByTestId(
    `authority-selector-readiness-${readyPosition.id}`,
  );
  await expect(satisfiedReadiness).toContainText(
    "Authority basis satisfied · position confirmed",
  );
  await expect(satisfiedReadiness).toContainText(
    "may enter Agent snapshots, approval-ready documents, and export",
  );
  if (!isMobile) {
    await page.setViewportSize({ width: 900, height: 1000 });
    await alignBelowShellHeader(satisfiedReadiness);
    await assertLayout();
    await page.screenshot({
      path: path.join(
        screenshotDir,
        "02-satisfied-authority-artifact-agent-eligible-900x1000.png",
      ),
      animations: "disabled",
      scale: "css",
    });
  }

  const withdrawalReason =
    "Counsel withdrew the final supporting link after the pleaded payment date changed.";
  await authoritySection
    .getByLabel("Withdrawal reason for Section 27 readiness")
    .fill(withdrawalReason);
  const withdrawPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/position-authorities/${readyLink.id}/withdraw`),
  );
  await authoritySection
    .getByLabel("Withdrawal reason for Section 27 readiness")
    .locator("xpath=../..")
    .getByRole("button", { name: "Withdraw link" })
    .click();
  expect((await withdrawPromise).ok()).toBe(true);
  await expect(
    page.getByTestId(`position-authority-readiness-${readyPosition.id}`),
  ).toContainText("Authority basis missing");
  await expect(authoritySection).toContainText(
    `Withdrawal reason: ${withdrawalReason}`,
  );
  const withdrawnSnapshot = inspectSnapshot();
  expect(withdrawnSnapshot.positionIds).not.toContain(readyPosition.id);
  expect(withdrawnSnapshot.positionIds).toContain(missingPosition.id);

  const matterAfterWithdrawalResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${matterId}`,
  );
  const matterAfterWithdrawal =
    (await matterAfterWithdrawalResponse.json()) as {
      workProducts: Array<{
        id: string;
        stale_at: string | null;
        stale_reason: string | null;
      }>;
    };
  const staleArtifact = matterAfterWithdrawal.workProducts.find(
    (product) => product.id === eligibleArtifact.id,
  );
  expect(staleArtifact?.stale_at).toBeTruthy();
  expect(staleArtifact?.stale_reason).toBeTruthy();
  await page.goto(`${matterUrl}?view=artifacts`);
  const litigationBriefRow = page
    .getByRole("heading", { name: "Litigation brief" })
    .locator("xpath=ancestor::article[1]");
  await expect(litigationBriefRow).toContainText("Stale");
  await expect(litigationBriefRow).toContainText(
    "Regenerate before approval or export",
  );

  if (isMobile) {
    await page.goto(`${matterUrl}?view=positions`);
    await authoritySection
      .getByLabel("Position for authority")
      .selectOption(readyPosition.id);
    const withdrawnLinkRow = authoritySection
      .getByText(`Withdrawal reason: ${withdrawalReason}`, { exact: true })
      .locator("xpath=../..");
    await alignBelowShellHeader(withdrawnLinkRow);
    await assertLayout();
    await page.screenshot({
      path: path.join(
        screenshotDir,
        "03-withdrawn-missing-recovery-393x852.png",
      ),
      animations: "disabled",
      scale: "css",
    });
  }

  if (!isMobile) {
    await page.goto(`${matterUrl}?view=positions`);
  }
  const retirementReason =
    "Counsel retired this authority version because the official text was superseded.";
  await authoritySection
    .getByLabel("Authority retirement reason")
    .fill(retirementReason);
  await authoritySection
    .getByRole("button", { name: "Retire version", exact: true })
    .click();
  await expect(
    authoritySection.getByText("retired", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByTestId(`position-authority-readiness-${missingPosition.id}`),
  ).toContainText("Authority basis invalid");
  const retiredLink = await page.request.post(
    `${apiBase}/aletheia/matters/${matterId}/litigation/position-authorities`,
    { data: linkPayload(readyPosition.id) },
  );
  expect(retiredLink.status()).toBe(400);
  expect(await retiredLink.json()).toMatchObject({
    detail: expect.stringContaining("must be verified and matter-scoped"),
  });
});

test("counsel round-trips DOCX revisions, diffs, and locks document drafts", async ({
  page,
}, testInfo) => {
  const state = fixture(testInfo.project.name);
  const apiBase = `http://127.0.0.1:${state.backendPort}`;
  const matterWrite = await page.request.post(`${apiBase}/aletheia/matters`, {
    data: {
      title: `Document drafting lifecycle ${testInfo.project.name}`,
      template: "civil_litigation",
      objective: "Prepare and review immutable litigation document versions.",
      status: "in_progress",
    },
  });
  expect(matterWrite.status()).toBe(201);
  const matter = (await matterWrite.json()) as { id: string };
  const matterUrl = `/aletheia/matters/${matter.id}/litigation?view=artifacts`;
  const artifactWrite = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/artifacts/litigation_brief`,
  );
  expect(artifactWrite.status()).toBe(201);
  const artifact = (await artifactWrite.json()) as {
    id: string;
    content_hash: string;
    dependency_hash: string;
  };

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(matterUrl);
  const workspace = page.getByTestId("document-draft-workspace");
  await expect(
    workspace.getByRole("heading", { name: "Document drafts" }),
  ).toBeVisible();
  await expect(
    workspace.getByLabel("Source artifact for document draft"),
  ).toContainText("Litigation brief");

  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/artifacts/${artifact.id}/document-draft`),
  );
  await workspace
    .getByRole("button", { name: "Create editable draft" })
    .click();
  const createdResponse = await createResponsePromise;
  expect(createdResponse.status()).toBe(201);
  const created = (await createdResponse.json()) as {
    id: string;
    source_content_hash: string;
    source_dependency_hash: string;
    versions: Array<{
      id: string;
      version: number;
      content_hash: string;
      sections: Array<{ id: string; heading: string; body: string }>;
    }>;
  };
  expect(created.source_content_hash).toBe(artifact.content_hash);
  expect(created.source_dependency_hash).toBe(artifact.dependency_hash);
  expect(created.versions[0]?.sections.map((section) => section.id)).toEqual([
    "procedural-posture",
    "material-facts",
    "issues",
    "sources",
  ]);

  const draft = page.getByTestId(`document-draft-${created.id}`);
  await expect(draft).toContainText(created.versions[0].content_hash);
  await expect(draft.getByText("Read-only source projection")).toBeVisible();
  await expect(draft.getByLabel("Sources body", { exact: true })).toHaveCount(
    0,
  );
  await expect(draft).toContainText("server artifact projection");

  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-12-document-roundtrip",
  );
  const capture = async (
    name: string,
    width: number,
    height: number,
    target: Locator,
  ) => {
    await page.setViewportSize({ width, height });
    await target.scrollIntoViewIfNeeded();
    await target.evaluate((element) => {
      const scroller = document.querySelector<HTMLElement>(
        ".aletheia-shell > div > main.overflow-y-auto",
      );
      if (!scroller) return;
      const offset =
        element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        8;
      scroller.scrollTop += offset;
    });
    await page.waitForTimeout(150);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    const shellOverlap = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(
        ".aletheia-mobile-header",
      );
      const scroller = document.querySelector<HTMLElement>(
        ".aletheia-shell > div > main.overflow-y-auto",
      );
      if (!header || !scroller) return 0;
      return (
        header.getBoundingClientRect().bottom -
        scroller.getBoundingClientRect().top
      );
    });
    expect(shellOverlap).toBeLessThanOrEqual(1);
    if (
      process.env.ALETHEIA_CAPTURE_DOCUMENT_DRAFTS === "true" &&
      testInfo.project.name === "desktop-chromium"
    ) {
      mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({
        path: path.join(screenshotDir, name),
        animations: "disabled",
      });
    }
  };

  const wordOperation = draft.getByTestId("document-word-roundtrip");
  const exportVersion = wordOperation.getByLabel("Word export version");
  const revisedDocument = wordOperation.getByLabel("Revised Word document");
  const importSummary = wordOperation.getByLabel("Word import change summary");
  const importButton = wordOperation.getByRole("button", {
    name: "Import new version",
  });
  await expect(exportVersion).toHaveValue(created.versions[0].id);
  await expect(exportVersion).toContainText("v1 · current");
  await expect(importButton).toBeDisabled();

  const [initialDownload] = await Promise.all([
    page.waitForEvent("download"),
    wordOperation.getByRole("button", { name: "Download DOCX" }).click(),
  ]);
  expect(initialDownload.suggestedFilename()).toMatch(/v1\.docx$/i);
  const initialDownloadPath = await initialDownload.path();
  expect(initialDownloadPath).toBeTruthy();
  const downloadedDocx = readFileSync(initialDownloadPath!);
  expect(downloadedDocx.subarray(0, 2).toString()).toBe("PK");
  const downloadedArchive = await JSZip.loadAsync(downloadedDocx);
  expect(downloadedArchive.file("word/document.xml")).not.toBeNull();

  await revisedDocument.setInputFiles({
    name: "counsel-v1-unchanged.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: downloadedDocx,
  });
  await importSummary.fill("Checked in Word without revising the draft.");
  const unchangedResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/document-drafts/${created.id}/docx-import`),
  );
  await importButton.click();
  const unchangedResponse = await unchangedResponsePromise;
  expect(unchangedResponse.status()).toBe(409);
  await expect(unchangedResponse.json()).resolves.toMatchObject({
    code: "DOCX_NO_CHANGES",
  });
  await expect(revisedDocument).toHaveValue(/counsel-v1-unchanged\.docx$/);
  await expect(importSummary).toHaveValue(
    "Checked in Word without revising the draft.",
  );

  const trackedDocx = await reviseDraftDocx(
    downloadedDocx,
    "Proposed tracked revision that has not been accepted.",
    true,
  );
  await revisedDocument.setInputFiles({
    name: "counsel-v1-tracked.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: trackedDocx,
  });
  await importSummary.fill("Attempted import with unresolved tracked changes.");
  const trackedResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/document-drafts/${created.id}/docx-import`),
  );
  await importButton.click();
  const trackedResponse = await trackedResponsePromise;
  expect(trackedResponse.status()).toBe(400);
  await expect(trackedResponse.json()).resolves.toMatchObject({
    code: "DOCX_TRACKED_CHANGES",
  });
  const importHistory = draft.getByTestId("document-import-history");
  await expect(importHistory).toContainText("DOCX_NO_CHANGES");
  await expect(importHistory).toContainText("DOCX_TRACKED_CHANGES");
  await expect(importHistory).toContainText(
    "Accept or reject all tracked changes in Word",
  );

  const malformedResponse = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/document-drafts/${created.id}/docx-import`,
    {
      multipart: {
        document: {
          name: "malformed-direct-upload.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          buffer: Buffer.from("not-a-zip-package"),
        },
        changeSummary: "Malformed direct upload must fail closed.",
      },
    },
  );
  expect(malformedResponse.status()).toBe(400);
  await expect(malformedResponse.json()).resolves.toMatchObject({
    code: "DOCX_INVALID",
  });
  const rejectedDetailResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/document-drafts/${created.id}`,
  );
  expect(rejectedDetailResponse.ok()).toBe(true);
  const rejectedDetail = (await rejectedDetailResponse.json()) as {
    versions: Array<{ version: number }>;
    import_attempts: Array<Record<string, unknown>>;
  };
  expect(rejectedDetail.versions).toHaveLength(1);
  expect(rejectedDetail.import_attempts).toHaveLength(3);
  expect(rejectedDetail.import_attempts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ failure_code: "DOCX_NO_CHANGES" }),
      expect.objectContaining({ failure_code: "DOCX_TRACKED_CHANGES" }),
      expect.objectContaining({ failure_code: "DOCX_INVALID" }),
    ]),
  );
  expect(
    rejectedDetail.import_attempts.some((attempt) => "storage_path" in attempt),
  ).toBe(false);
  await page.reload();
  await expect(importHistory).toContainText("malformed-direct-upload.docx");
  await expect(importHistory).toContainText("DOCX_INVALID");
  await capture("02-rejected-import-history-900.png", 900, 1000, importHistory);

  const revisedBody =
    "Counsel revision: the record is presently limited; preserve the issue for verified evidence review.";
  const revisedDocx = await reviseDraftDocx(downloadedDocx, revisedBody);
  await revisedDocument.setInputFiles({
    name: "counsel-reviewed-v1.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: revisedDocx,
  });
  const changeSummary =
    "Clarified the material-facts section in Word and preserved the evidence qualification.";
  await importSummary.fill(changeSummary);
  const importResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/document-drafts/${created.id}/docx-import`),
  );
  await importButton.click();
  const importResponse = await importResponsePromise;
  expect(importResponse.status()).toBe(201);
  const versioned = (await importResponse.json()) as {
    versions: Array<{
      id: string;
      version: number;
      content_hash: string;
      sections: Array<{ id: string; heading: string; body: string }>;
      change_summary: string;
      review_status: string;
      provenance: Record<string, unknown>;
    }>;
  };
  const latest = versioned.versions.at(-1)!;
  expect(latest.version).toBe(2);
  expect(latest.content_hash).not.toBe(created.versions[0].content_hash);
  expect(latest.change_summary).toBe(changeSummary);
  expect(latest.review_status).toBe("unreviewed");
  expect(latest.provenance).toMatchObject({
    source: "external_docx_import",
    baseVersion: 1,
    baseVersionId: created.versions[0].id,
    originalFilename: "counsel-reviewed-v1.docx",
  });
  const acceptedDetailResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/document-drafts/${created.id}`,
  );
  expect(acceptedDetailResponse.ok()).toBe(true);
  const acceptedDetail = (await acceptedDetailResponse.json()) as {
    import_attempts: Array<{
      status: string;
      original_filename: string;
      accepted_version_id: string | null;
    }>;
  };
  expect(acceptedDetail.import_attempts[0]).toMatchObject({
    status: "accepted",
    original_filename: "counsel-reviewed-v1.docx",
    accepted_version_id: latest.id,
  });
  await expect(draft).toContainText("v2 · unreviewed");
  await expect(draft).toContainText(latest.content_hash);
  await expect(draft).toContainText(
    "Imported counsel-reviewed-v1.docx as unreviewed v2.",
  );
  await expect(revisedDocument).toHaveValue("");
  await expect(importSummary).toHaveValue("");
  await expect(draft.getByLabel("Document version review reason")).toHaveValue(
    "",
  );
  await expect(importHistory).toContainText("Accepted as v2");
  await expect(importHistory).toContainText("counsel-reviewed-v1.docx");

  const diffResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes(`/document-drafts/${created.id}/diff?`) &&
      response.url().includes("fromVersion=1") &&
      response.url().includes("toVersion=2"),
  );
  await draft.getByRole("button", { name: "Compare" }).click();
  const diffResponse = await diffResponsePromise;
  expect(diffResponse.ok()).toBe(true);
  const diff = (await diffResponse.json()) as {
    changes: Array<{ id: string; status: string }>;
  };
  expect(diff.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "material-facts", status: "modified" }),
      expect.objectContaining({ id: "sources", status: "unchanged" }),
    ]),
  );
  await expect(
    draft.getByTestId("document-version-diff").getByText("material-facts"),
  ).toBeVisible();
  await expect(draft).toContainText(revisedBody);
  await capture("01-accepted-roundtrip-1440.png", 1440, 1000, wordOperation);

  await page.reload();
  await expect(draft).toContainText("v2 · unreviewed");
  await expect(draft).toContainText(revisedBody);
  await expect(importHistory).toContainText("Accepted as v2");
  await expect(importHistory).toContainText("DOCX_NO_CHANGES");
  await expect(draft.getByLabel("Document version review reason")).toHaveValue(
    "",
  );
  await expect(exportVersion).toHaveValue(latest.id);
  await expect(exportVersion).toContainText("v1 · historical");

  const eventWrite = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/procedural-events`,
    {
      data: {
        eventType: "filing",
        title: "Complaint filed after draft review",
        occurredAt: "2026-07-11T04:00:00.000Z",
        source: null,
        createdBy: "human",
      },
    },
  );
  expect(eventWrite.status()).toBe(201);
  const event = (await eventWrite.json()) as { id: string };
  const eventDecision = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/procedural-events/${event.id}/decision`,
    { data: { decision: "confirmed", comment: "Filing record checked." } },
  );
  expect(eventDecision.ok()).toBe(true);
  await page.reload();
  const staleDraft = page.getByTestId(`document-draft-${created.id}`);
  await expect(staleDraft).toContainText("Stale · editing and review locked");
  await expect(staleDraft).toContainText(
    "Explicit withdrawal remains available.",
  );
  await expect(
    staleDraft.getByRole("button", { name: "Save new version" }),
  ).toBeDisabled();
  await expect(staleDraft.getByLabel("Material Facts body")).toBeDisabled();
  const staleWordOperation = staleDraft.getByTestId("document-word-roundtrip");
  await expect(staleWordOperation).toContainText(
    "Import locked · version downloads remain available",
  );
  await expect(
    staleWordOperation.getByLabel("Revised Word document"),
  ).toBeDisabled();
  await expect(
    staleWordOperation.getByLabel("Word import change summary"),
  ).toBeDisabled();
  await expect(
    staleWordOperation.getByRole("button", { name: "Import new version" }),
  ).toBeDisabled();
  const staleExportVersion = staleWordOperation.getByLabel(
    "Word export version",
  );
  await staleExportVersion.selectOption(created.versions[0].id);
  await expect(staleExportVersion).toHaveValue(created.versions[0].id);
  const staleDownloadButton = staleWordOperation.getByRole("button", {
    name: "Download DOCX",
  });
  await expect(staleDownloadButton).toBeEnabled();
  const [historicalDownload] = await Promise.all([
    page.waitForEvent("download"),
    staleDownloadButton.click(),
  ]);
  expect(historicalDownload.suggestedFilename()).toMatch(/v1\.docx$/i);
  await capture(
    "03-stale-locked-mobile-393.png",
    393,
    852,
    staleDraft.locator("header"),
  );

  const staleDiffResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes(`/document-drafts/${created.id}/diff?`) &&
      response.url().includes("fromVersion=1") &&
      response.url().includes("toVersion=2"),
  );
  await staleDraft.getByRole("button", { name: "Compare" }).click();
  const staleDiffResponse = await staleDiffResponsePromise;
  expect(staleDiffResponse.ok()).toBe(true);
  const staleDiff = (await staleDiffResponse.json()) as {
    document: { stale: boolean };
    changes: Array<{ id: string; status: string }>;
  };
  expect(staleDiff.document.stale).toBe(true);
  expect(staleDiff.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "material-facts", status: "modified" }),
      expect.objectContaining({ id: "sources", status: "unchanged" }),
    ]),
  );
  const staleDiffPanel = staleDraft.getByTestId("document-version-diff");
  await expect(staleDiffPanel).toContainText(
    "Historical diff · source binding stale",
  );
  await expect(
    staleDiffPanel.locator("article").filter({ hasText: "material-facts" }),
  ).toContainText("modified");
  await expect(
    staleDiffPanel.locator("article").filter({ hasText: "sources" }),
  ).toContainText("unchanged");

  const staleWrite = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/document-drafts/${created.id}/versions`,
    {
      data: {
        baseVersion: 2,
        changeSummary: "Attempted stale write",
        sections: latest.sections,
      },
    },
  );
  expect(staleWrite.status()).toBe(409);
  await expect(staleWrite.json()).resolves.toMatchObject({
    detail: expect.stringContaining("stale"),
  });

  const withdrawalReason =
    "Source state changed; counsel expressly withdraws this stale working draft.";
  await staleDraft
    .getByLabel("Document draft withdrawal reason")
    .fill(withdrawalReason);
  const withdrawalRequestPromise = page.waitForRequest((request) =>
    request.url().endsWith(`/document-drafts/${created.id}/withdraw`),
  );
  const withdrawalResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/document-drafts/${created.id}/withdraw`),
  );
  await staleDraft.getByRole("button", { name: "Withdraw draft" }).click();
  expect((await withdrawalRequestPromise).postDataJSON()).toEqual({
    reason: withdrawalReason,
  });
  expect((await withdrawalResponsePromise).ok()).toBe(true);
  await expect(staleDraft).toContainText("Withdrawn");
  await expect(staleDraft).toContainText(withdrawalReason);
  await expect(
    staleWordOperation.getByRole("button", { name: "Import new version" }),
  ).toBeDisabled();
  await expect(staleDownloadButton).toBeEnabled();
  await expect(staleDraft.getByTestId("document-import-history")).toContainText(
    "Accepted as v2",
  );
  await expect(
    staleDraft.getByRole("button", { name: "Save new version" }),
  ).toBeDisabled();
  await expect(
    staleDraft.getByLabel("Document draft withdrawal reason"),
  ).toHaveCount(0);

  const auditedMatterResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${matter.id}`,
  );
  expect(auditedMatterResponse.ok()).toBe(true);
  const auditedMatter = (await auditedMatterResponse.json()) as {
    auditEvents: Array<{
      action: string;
      details: Record<string, unknown>;
    }>;
  };
  expect(auditedMatter.auditEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "litigation_document_draft_withdrawn",
        details: expect.objectContaining({
          documentId: created.id,
          reason: withdrawalReason,
          stale: true,
        }),
      }),
    ]),
  );

  const withdrawnWrite = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/document-drafts/${created.id}/versions`,
    {
      data: {
        baseVersion: 2,
        changeSummary: "Attempted withdrawn write",
        sections: latest.sections,
      },
    },
  );
  expect(withdrawnWrite.status()).toBe(409);
  await expect(withdrawnWrite.json()).resolves.toMatchObject({
    detail: expect.stringContaining("withdrawn"),
  });
});

test("artifact export approval renders server projections and refreshes revoked access", async ({
  page,
}, testInfo) => {
  const state = fixture(testInfo.project.name);
  const generated = await page.request.post(
    `http://127.0.0.1:${state.backendPort}/aletheia/matters/${state.matterId}/litigation/artifacts/evidence_catalog`,
  );
  expect(generated.ok()).toBe(true);
  const generatedProduct = await generated.json();
  await page.route(`**/aletheia/matters/${state.matterId}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as {
      workProducts: Array<{ id: string }>;
    };
    body.workProducts = [
      ...body.workProducts.filter(
        (product) => product.id !== generatedProduct.id,
      ),
      generatedProduct,
    ];
    await route.fulfill({ response, json: body });
  });

  await page.goto(state.matterUrl);
  await expect(
    page.getByRole("heading", { name: state.matterTitle }),
  ).toBeVisible();
  await page.getByRole("button", { name: "文书与庭审" }).click();

  const artifact = page
    .locator("article")
    .filter({ hasText: "Evidence catalog" });
  await expect(artifact).toContainText(/v\d+/);

  const matterResponse = await page.request.get(
    `http://127.0.0.1:${state.backendPort}/aletheia/matters/${state.matterId}`,
  );
  expect(matterResponse.ok()).toBe(true);
  const matter = (await matterResponse.json()) as {
    workProducts: Array<{
      id: string;
      kind: string;
      version: number;
      content_hash: string;
    }>;
  };
  const product = matter.workProducts
    .filter((item) => item.kind === "evidence_catalog")
    .sort((left, right) => right.version - left.version)[0];
  expect(product).toBeTruthy();

  type ProjectionMode =
    | "zero"
    | "one"
    | "two"
    | "rejected"
    | "stale"
    | "single"
    | "singleApproved"
    | "aclRevoked"
    | "exported";
  let mode: ProjectionMode = "zero";
  const checkpointId = "checkpoint-controlled-export-approval";
  const governanceRequestId = "governance-request-controlled-2026-07-11";
  const requesterId = "principal-requester";
  const firstVote = {
    principalId: "principal-reviewer-one",
    role: "matter_reviewer",
    decision: "approved",
    comment: "Source binding and export scope reviewed.",
    createdAt: "2026-07-11T09:12:00.000Z",
  };
  const secondVote = {
    principalId: "principal-reviewer-two",
    role: "matter_exporter",
    decision: "approved",
    comment: null,
    createdAt: "2026-07-11T09:18:00.000Z",
  };

  const projection = () => {
    const single = mode === "single" || mode === "singleApproved";
    const approved =
      mode === "two" || mode === "aclRevoked" || mode === "exported";
    const votes =
      mode === "one" ? [firstVote] : approved ? [firstVote, secondVote] : [];
    const rejected = mode === "rejected";
    const stale = mode === "stale";
    return {
      approvalCheckpointId: checkpointId,
      workProductId: product.id,
      version: product.version,
      contentHash: product.content_hash,
      checkpointStatus: stale
        ? "stale"
        : rejected
          ? "rejected"
          : approved || mode === "singleApproved"
            ? "approved"
            : "open",
      governanceRequest: single
        ? null
        : {
            id: governanceRequestId,
            requesterId,
            status: approved ? "approved" : rejected ? "rejected" : "pending",
            approvedVotes: votes.filter((vote) => vote.decision === "approved")
              .length,
            rejectedVotes: rejected ? 1 : 0,
            requiredApprovals: 2,
            requireDistinctRoles: true,
            votes,
          },
      actor: {
        id: mode === "zero" ? requesterId : "principal-current-reviewer",
        canVote: mode === "one",
        canExport: mode !== "aclRevoked",
        voteBlockReason: single
          ? "independent_approval_not_required"
          : mode === "zero"
            ? "requester_cannot_vote"
            : stale
              ? "artifact_binding_stale"
              : rejected
                ? "governance_request_rejected"
                : approved
                  ? "governance_request_approved"
                  : null,
      },
      independentApproval: {
        required: !single,
        status: stale
          ? "stale"
          : rejected
            ? "rejected"
            : approved || mode === "singleApproved"
              ? "approved"
              : "pending",
        approvedBy: single
          ? mode === "singleApproved"
            ? ["local-user"]
            : []
          : votes.map((vote) => vote.principalId),
      },
      export:
        mode === "exported"
          ? {
              status: "exported",
              exportId: "export-controlled-1",
              exportedBy: "principal-export-operator",
              exportedAt: "2026-07-11T09:24:00.000Z",
            }
          : null,
    };
  };

  await page.route(
    `**/aletheia/matters/${state.matterId}/litigation/artifacts/${product.id}/export-approval`,
    async (route) => {
      await route.fulfill({ json: projection() });
    },
  );

  const reloadArtifacts = async () => {
    await page.reload();
    await expect(
      artifact.getByText("Export approval", { exact: true }),
    ).toBeVisible();
  };

  await reloadArtifacts();
  await expect(artifact).toContainText("0 / 2");
  await expect(artifact.getByTitle(requesterId)).toBeVisible();
  await expect(artifact.getByTitle(governanceRequestId)).toBeVisible();
  await expect(artifact).toContainText(
    "Approvals must come from distinct eligible roles.",
  );
  await expect(artifact).toContainText(
    "The requester cannot vote on this approval.",
  );
  await expect(artifact.getByRole("button", { name: "Approve" })).toHaveCount(
    0,
  );

  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-11-export-approval",
  );
  const captureApproval = async (name: string, width: number) => {
    await page.setViewportSize({ width, height: width === 900 ? 1100 : 1000 });
    await artifact.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);
    await page.screenshot({
      path: path.join(screenshotDir, `${name}.png`),
      animations: "disabled",
    });
  };

  mode = "single";
  await reloadArtifacts();
  await expect(
    artifact.getByText("Non-independent local approval", { exact: true }),
  ).toBeVisible();
  await expect(artifact).toContainText("does not provide dual control");
  await expect(
    artifact.getByRole("button", { name: "Approve locally" }),
  ).toBeVisible();
  if (
    process.env.ALETHEIA_CAPTURE_APPROVAL_AUDIT === "true" &&
    testInfo.project.name === "desktop-chromium"
  ) {
    mkdirSync(screenshotDir, { recursive: true });
    await captureApproval("01-single-user-desktop", 1440);
    await captureApproval("02-single-user-900px", 900);
  }

  let localDecisionBody: Record<string, unknown> | null = null;
  await page.route(
    `**/aletheia/matters/${state.matterId}/approvals/${checkpointId}/decision`,
    async (route) => {
      localDecisionBody = route.request().postDataJSON() as Record<
        string,
        unknown
      >;
      mode = "singleApproved";
      await route.fulfill({ json: { id: checkpointId, status: "approved" } });
    },
  );
  await artifact.getByRole("button", { name: "Approve locally" }).click();
  expect(localDecisionBody).toMatchObject({ decision: "approved" });
  await expect(
    artifact.getByRole("button", { name: "Export approved DOCX" }),
  ).toBeVisible();

  mode = "one";
  await reloadArtifacts();
  await expect(artifact).toContainText("1 / 2");
  await expect(artifact.getByTitle("principal-reviewer-one")).toBeVisible();
  await expect(artifact).toContainText("matter_reviewer");
  await expect(artifact).toContainText(
    "Source binding and export scope reviewed.",
  );
  await expect(artifact.getByRole("button", { name: "Approve" })).toBeVisible();
  if (
    process.env.ALETHEIA_CAPTURE_APPROVAL_AUDIT === "true" &&
    testInfo.project.name === "desktop-chromium"
  ) {
    await captureApproval("03-multi-principal-desktop", 1440);
    await captureApproval("04-multi-principal-900px", 900);
  }

  let voteBody: Record<string, unknown> | null = null;
  await page.route(
    `**/aletheia/matters/${state.matterId}/litigation/artifacts/${product.id}/export-approval/votes`,
    async (route) => {
      voteBody = route.request().postDataJSON() as Record<string, unknown>;
      mode = "two";
      await route.fulfill({ json: projection() });
    },
  );
  await artifact.getByRole("button", { name: "Approve" }).click();
  expect(voteBody).toEqual({
    approvalCheckpointId: checkpointId,
    decision: "approved",
  });
  await expect(artifact).toContainText("2 / 2");
  await expect(artifact).toContainText("Independent approval: approved");
  await expect(
    artifact.getByRole("button", { name: "Export approved DOCX" }),
  ).toBeVisible();

  mode = "rejected";
  await reloadArtifacts();
  await expect(artifact).toContainText("rejected");
  await expect(artifact).toContainText("The governance request is rejected.");
  await expect(
    artifact.getByRole("button", { name: "Export approved DOCX" }),
  ).toHaveCount(0);

  mode = "stale";
  await reloadArtifacts();
  await expect(artifact).toContainText("stale");
  await expect(artifact).toContainText(
    "This approval no longer matches the current artifact version.",
  );
  await expect(
    artifact.getByRole("button", { name: "Request export approval" }),
  ).toHaveCount(0);

  mode = "two";
  await reloadArtifacts();
  await page.route(
    `**/aletheia/matters/${state.matterId}/litigation/artifacts/${product.id}/export`,
    async (route) => {
      mode = "aclRevoked";
      await route.fulfill({
        status: 403,
        json: { detail: "Export permission was revoked." },
      });
    },
  );
  await artifact.getByRole("button", { name: "Export approved DOCX" }).click();
  await expect(page.getByText("Export permission was revoked.")).toBeVisible();
  await expect(
    artifact.getByRole("button", { name: "Export approved DOCX" }),
  ).toHaveCount(0);

  mode = "exported";
  await reloadArtifacts();
  await expect(artifact.getByTitle("principal-export-operator")).toBeVisible();
  await expect(artifact).toContainText("Exported DOCX ready");
  const finalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(finalOverflow).toBe(false);
});

test("local finding semantic advice persists without changing counsel review", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    !semanticFixtureEnabled,
    "Set ALETHEIA_FINDING_ENTAILMENT_FIXTURE=1 with the deterministic loopback model config.",
  );
  const state = fixture(testInfo.project.name);
  const apiBase = `http://127.0.0.1:${state.backendPort}`;
  const setSemanticFailure = async (enabled: boolean) => {
    const response = await request.post(
      `http://127.0.0.1:${semanticRuntimePort}/__fixture/semantic-failure`,
      { data: { enabled } },
    );
    expect(response.ok()).toBe(true);
  };
  await setSemanticFailure(false);

  const modelStart = await request.post(
    `${apiBase}/aletheia/local-models/${semanticModelId}/start`,
  );
  expect(modelStart.ok()).toBe(true);

  const settingsRead = await request.get(`${apiBase}/aletheia/client-settings`);
  expect(settingsRead.ok()).toBe(true);
  const settingsEtag = settingsRead.headers().etag;
  expect(settingsEtag).toBeTruthy();
  const settingsWrite = await request.patch(
    `${apiBase}/aletheia/client-settings`,
    {
      headers: { "If-Match": settingsEtag! },
      data: {
        defaultModel: semanticModelId,
        litigationModelId: semanticModelId,
        reasoning: "Off",
        fastMode: false,
      },
    },
  );
  expect(settingsWrite.ok()).toBe(true);

  const calibration = await request.post(
    `${apiBase}/aletheia/local-models/${semanticModelId}/calibrate`,
  );
  expect(calibration.ok()).toBe(true);
  const benchmark = await request.post(
    `${apiBase}/aletheia/local-models/${semanticModelId}/benchmark`,
  );
  expect(benchmark.ok()).toBe(true);

  type PersistedRun = {
    id: string;
    status: string;
    steps: Array<{ id: string }>;
    fixtureSourceId: string;
  };
  const backendDir = path.resolve(process.cwd(), "..", "backend");
  const seedScript = `
    import { LocalAletheiaRepository } from "./src/lib/aletheia/localRepository";
    import { DurableAgentQueue, DurableAgentWorker } from "./src/lib/aletheia/durableAgentExecutor";
    import { LITIGATION_GROUNDED_HANDLER } from "./src/lib/aletheia/litigationGrounding";

    async function main() {
    const userId = "local-user";
    const matterId = process.env.SEMANTIC_FIXTURE_MATTER_ID!;
    const modelId = process.env.SEMANTIC_FIXTURE_MODEL_ID!;
    const repository = new LocalAletheiaRepository();
    const snapshot = await repository.prepareLitigationAgentSnapshot(
      { userId },
      matterId,
    ) as Record<string, any>;
    const source = (snapshot.sources as Array<Record<string, any>>).find(
      (item) => item.id && item.quote && item.quoteSha256,
    );
    if (!source) throw new Error("The litigation fixture has no cited source.");
    const citation = { sourceId: String(source.id), quote: String(source.quote) };
    const structuredOutput = {
      summary: "The confirmed record supports a bounded litigation finding.",
      summaryCitations: [citation],
      findings: [{
        statement: "The confirmed source provides evidence relevant to the disputed payment timing.",
        citations: [citation],
        confidence: "medium",
        uncertainty: "Counsel must assess the legal effect of the source.",
      }],
      questionsForCounsel: ["What additional record would resolve the remaining legal effect?"],
    };
    const queue = new DurableAgentQueue();
    const seeded = queue.enqueue({
      matterId,
      userId,
      workflow: "aletheia-civil-litigation-harness-v1",
      goal: "Prepare a source-grounded litigation analysis and hearing checklist.",
      modelProfile: modelId,
      metadata: {
        source: "server_owned_litigation_workflow",
        statePolicy: snapshot.statePolicy,
        stateHash: snapshot.stateHash,
        snapshotHash: snapshot.snapshotHash,
        executionMode: "single_snapshot",
        partitionCount: 1,
        partitionHashes: [snapshot.snapshotHash],
        modelRouting: { role: "litigation_analysis", modelId },
      },
      steps: [{
        key: "analyze_confirmed_case_state",
        title: "Analyze confirmed case state",
        handler: LITIGATION_GROUNDED_HANDLER,
        input: {
          snapshotHash: snapshot.snapshotHash,
          allowedSources: [{ id: source.id, quoteSha256: source.quoteSha256 }],
        },
      }],
    }) as Record<string, any>;
    const worker = new DurableAgentWorker(
      queue,
      {
        async execute() {
          return {
            text: "Grounded analysis complete.",
            structuredOutput,
            grounding: {
              verified: true,
              exactQuotesVerified: true,
              snapshotHash: snapshot.snapshotHash,
              findingCount: 1,
              citationCount: 2,
              citedSourceIds: [source.id],
            },
          };
        },
      },
      { workerId: "semantic-fixture-worker", heartbeatIntervalMs: 50 },
    );
    await worker.runOnce();
    const completed = queue.getRun(userId, seeded.id);
    queue.close();
    process.stdout.write("SEMANTIC_RUN_JSON=" + JSON.stringify({
      ...completed,
      fixtureSourceId: String(source.id),
    }));
    }
    void main().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const seededOutput = execFileSync(
    path.join(backendDir, "node_modules", ".bin", "tsx"),
    ["-e", seedScript],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        ALETHEIA_DATA_DIR: state.dataDir,
        SEMANTIC_FIXTURE_MATTER_ID: state.matterId,
        SEMANTIC_FIXTURE_MODEL_ID: semanticModelId,
      },
      encoding: "utf8",
    },
  );
  const seededMarker = "SEMANTIC_RUN_JSON=";
  const seededMarkerIndex = seededOutput.lastIndexOf(seededMarker);
  expect(seededMarkerIndex).toBeGreaterThanOrEqual(0);
  const persistedRun = JSON.parse(
    seededOutput.slice(seededMarkerIndex + seededMarker.length),
  ) as PersistedRun;
  expect(persistedRun.status).toBe("succeeded");
  expect(persistedRun.steps.length).toBeGreaterThan(0);
  const stepId = persistedRun.steps[0].id;
  const semanticRoute = `${apiBase}/aletheia/matters/${state.matterId}/litigation/agent-runs/${persistedRun.id}/steps/${stepId}/findings/0/semantic-check`;

  const prematureWrite = await request.post(semanticRoute, {
    data: { derived_verdict: "supported" },
  });
  expect(prematureWrite.status()).toBe(400);
  expect(await prematureWrite.json()).toMatchObject({
    detail:
      "An open Agent output review is required before requesting semantic advice.",
  });

  const outputReviewWrite = await request.post(
    `${apiBase}/aletheia/matters/${state.matterId}/litigation/agent-runs/${persistedRun.id}/review`,
  );
  expect(outputReviewWrite.status()).toBe(201);
  const outputReview = (await outputReviewWrite.json()) as { id: string };

  await page.route("**/aletheia/durable-executor/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, modelId: semanticModelId }),
    }),
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${state.matterUrl}?view=agent`);
  const finding = page.getByTestId(`agent-finding-review-${stepId}-0`);
  await expect(finding).toBeVisible();
  await expect(finding).toContainText(
    "Model advisory, not independent verification.",
  );
  await expect(finding).toContainText(
    "The same local model may grade its own output",
  );
  const humanAssessment = finding.getByLabel("Finding 1 assessment");
  const humanReason = finding.getByLabel("Finding 1 review reason");
  await expect(humanAssessment).toHaveValue("");
  await expect(humanReason).toHaveValue("");

  const runCheck = finding.getByRole("button", { name: "Run check" });
  await expect(runCheck).toBeEnabled();
  const semanticWritePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url() === semanticRoute,
  );
  await runCheck.click();
  expect((await semanticWritePromise).status()).toBe(201);
  await expect(finding).toContainText("Machine verdict: partially supported");
  await expect(finding).toContainText(
    "The exact citation supports the stated payment timing",
  );
  await expect(finding).toContainText("Citation partial");
  await expect(finding).toContainText(persistedRun.fixtureSourceId);
  await expect(finding).toContainText("Model revision");
  await expect(finding).toContainText("Calibration binding");
  await expect(finding).toContainText("Benchmark binding");
  await expect(humanAssessment).toHaveValue("");
  await expect(humanReason).toHaveValue("");

  const persistedWorkspaceResponse = await request.get(
    `${apiBase}/aletheia/matters/${state.matterId}/litigation`,
  );
  const persistedWorkspace = (await persistedWorkspaceResponse.json()) as {
    agent_finding_reviews: unknown[];
    agent_finding_semantic_checks: Array<{
      id: string;
      status: string;
      stale: boolean;
      derived_verdict: string;
      citation_assessments:
        | string
        | Array<{
            sourceId: string;
            assessment: string;
          }>;
      model_revision: string;
      calibration_id: string;
      benchmark_id: string;
    }>;
  };
  expect(persistedWorkspace.agent_finding_reviews).toHaveLength(0);
  expect(persistedWorkspace.agent_finding_semantic_checks).toHaveLength(1);
  const persistedCheck = persistedWorkspace.agent_finding_semantic_checks[0];
  expect(persistedCheck).toMatchObject({
    status: "succeeded",
    stale: false,
    derived_verdict: "partial",
  });
  const persistedAssessments =
    typeof persistedCheck.citation_assessments === "string"
      ? (JSON.parse(persistedCheck.citation_assessments) as Array<{
          sourceId: string;
          assessment: string;
        }>)
      : persistedCheck.citation_assessments;
  expect(persistedAssessments).toMatchObject([
    {
      sourceId: persistedRun.fixtureSourceId,
      assessment: "partial",
    },
  ]);
  expect(persistedCheck.model_revision).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(persistedCheck.calibration_id).toBeTruthy();
  expect(persistedCheck.benchmark_id).toBeTruthy();

  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-11-finding-entailment",
  );
  mkdirSync(screenshotDir, { recursive: true });
  const capture = async (name: string, width: number, height: number) => {
    await page.setViewportSize({ width, height });
    if (width === 393) {
      await finding
        .getByText("Local semantic check", { exact: true })
        .evaluate((element) =>
          element.scrollIntoView({ block: "start", behavior: "instant" }),
        );
    } else {
      await finding.scrollIntoViewIfNeeded();
    }
    await page.waitForTimeout(100);
    const findingRect = await finding.boundingBox();
    expect(findingRect).not.toBeNull();
    expect(findingRect!.x).toBeGreaterThanOrEqual(-1);
    expect(findingRect!.x + findingRect!.width).toBeLessThanOrEqual(width + 1);
    const measurements = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(
        ".aletheia-mobile-header",
      );
      const scroller = document.querySelector<HTMLElement>(
        ".aletheia-shell > div > main.overflow-y-auto",
      );
      const headerRect = header?.getBoundingClientRect();
      const scrollerRect = scroller?.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        overflow: Math.max(
          0,
          document.documentElement.scrollWidth - window.innerWidth,
        ),
        headerHeight: Math.round(headerRect?.height ?? 0),
        headerBottom: Math.round(headerRect?.bottom ?? 0),
        scrollerTop: Math.round(scrollerRect?.top ?? 0),
        headerOverlap:
          headerRect && scrollerRect
            ? Math.max(0, Math.round(headerRect.bottom - scrollerRect.top))
            : 0,
      };
    });
    console.log(`[finding-entailment-audit] ${JSON.stringify(measurements)}`);
    expect(measurements.overflow).toBe(0);
    expect(measurements.headerOverlap).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: path.join(screenshotDir, `${name}.png`),
      animations: "disabled",
    });
  };

  if (testInfo.project.name === "desktop-chromium") {
    await capture("01-supported-desktop-1440", 1440, 1000);
  }

  await page.reload();
  await expect(finding).toContainText("Machine verdict: partially supported");
  await expect(humanAssessment).toHaveValue("");
  await expect(humanReason).toHaveValue("");
  const afterRefreshWorkspace = (await (
    await request.get(
      `${apiBase}/aletheia/matters/${state.matterId}/litigation`,
    )
  ).json()) as {
    agent_finding_reviews: unknown[];
    agent_finding_semantic_checks: unknown[];
  };
  expect(afterRefreshWorkspace.agent_finding_reviews).toHaveLength(0);
  expect(afterRefreshWorkspace.agent_finding_semantic_checks).toHaveLength(1);

  await humanAssessment.selectOption("partial");
  await humanReason.fill(
    "Counsel has not yet completed the independent human assessment.",
  );
  await setSemanticFailure(true);
  await finding.getByRole("button", { name: "Run check" }).click();
  await expect(finding).toContainText("Failed");
  await expect(finding).toContainText("Model response is not valid JSON.");
  await expect(finding).toContainText("ENTAILMENT_INVALID_JSON");
  await expect(humanAssessment).toHaveValue("partial");
  await expect(humanReason).toHaveValue(
    "Counsel has not yet completed the independent human assessment.",
  );
  await setSemanticFailure(false);
  if (testInfo.project.name === "desktop-chromium") {
    await capture("02-failed-history-narrow-900", 900, 1000);
  }

  const decisionWrite = await request.post(
    `${apiBase}/aletheia/matters/${state.matterId}/litigation/agent-output-reviews/${outputReview.id}/decision`,
    {
      data: {
        decision: "rejected",
        comment:
          "Counsel returned the output; machine advice remains historical only.",
      },
    },
  );
  expect(decisionWrite.ok()).toBe(true);
  await page.reload();
  await expect(finding).toContainText("stale");
  await expect(finding).toContainText(
    "The output review is no longer open or no longer matches this check.",
  );
  await expect(
    finding.getByRole("button", { name: "Run check" }),
  ).toBeDisabled();

  const closedReviewWrite = await request.post(semanticRoute, {
    data: { derived_verdict: "supported", status: "succeeded" },
  });
  expect(closedReviewWrite.status()).toBe(400);
  const badIndexWrite = await request.post(
    semanticRoute.replace("/findings/0/", "/findings/not-an-index/"),
  );
  expect(badIndexWrite.status()).toBe(400);
  const finalWorkspace = (await (
    await request.get(
      `${apiBase}/aletheia/matters/${state.matterId}/litigation`,
    )
  ).json()) as {
    agent_finding_reviews: unknown[];
    agent_finding_semantic_checks: unknown[];
  };
  expect(finalWorkspace.agent_finding_reviews).toHaveLength(0);
  expect(finalWorkspace.agent_finding_semantic_checks).toHaveLength(2);
  if (testInfo.project.name === "desktop-chromium") {
    await capture("03-stale-history-mobile-393", 393, 852);
  }
});

test("litigation run exposes its verified snapshot provenance", async ({
  page,
}, testInfo) => {
  const state = fixture(testInfo.project.name);
  const snapshotHash = `sha256:${"a".repeat(64)}`;
  const runPayload = {
    id: "run-snapshot-1",
    matter_id: state.matterId,
    workflow: "aletheia-civil-litigation-harness-v1",
    goal: "Prepare a source-grounded litigation analysis and hearing checklist.",
    status: "succeeded",
    attempt_count: 1,
    deadline_at: "2026-08-10T09:00:00.000Z",
    error: null,
    metadata: {
      statePolicy: "confirmed_cited_no_open_review",
      executionMode: "source_partitioned",
      partitionCount: 3,
      retrievalFocus: "payment due date",
      snapshotHash,
      snapshotBytes: 4096,
      synthesisOfRunId: null as string | null,
      exclusions: {
        uncitedFacts: 1,
        uncitedPositions: 2,
        openPositionReviews: 1,
      },
    },
    steps: [
      {
        id: "step-1",
        step_key: "analyze_confirmed_case_state",
        title: "Analyze confirmed case state",
        status: "succeeded",
        attempt_count: 1,
        output: {
          text: "Grounded analysis complete. [source-1]",
          structuredOutput: {
            findings: [
              {
                statement:
                  "The payment due date is supported by the cited contract.",
                citations: [{ sourceId: "source-1", quote: "完整逐字引文" }],
                confidence: "high",
                uncertainty: null,
              },
            ],
          },
          grounding: {
            verified: true,
            exactQuotesVerified: true,
            snapshotHash,
            findingCount: 1,
            citationCount: 2,
            citedSourceIds: ["source-1"],
          },
        },
        error: null,
      },
    ],
    events: [
      {
        id: "event-1",
        sequence: 1,
        event_type: "run.succeeded",
        event_hash: "event-hash",
        created_at: "2026-07-10T09:00:00.000Z",
      },
    ],
  };
  let persistedRun: typeof runPayload | null = null;
  let agentReviews: Array<Record<string, unknown>> = [];
  const findingReviews: Array<Record<string, unknown>> = [];
  await page.route("**/aletheia/durable-executor/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ enabled: true, modelId: "local-audit-model" }),
    }),
  );
  await page.route("**/aletheia/matters/*/litigation-durable-runs", (route) => {
    persistedRun = runPayload;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify(runPayload),
    });
  });
  await page.route(
    "**/aletheia/matters/*/litigation-durable-runs/latest",
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(persistedRun),
      }),
  );
  await page.route(
    `http://127.0.0.1:3411/aletheia/matters/${state.matterId}/litigation`,
    async (route) => {
      const response = await route.fetch();
      const workspace = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        contentType: "application/json",
        body: JSON.stringify({
          ...workspace,
          agent_output_reviews: agentReviews,
          agent_finding_reviews: findingReviews,
        }),
      });
    },
  );
  await page.route(
    "**/aletheia/matters/*/litigation/agent-runs/*/steps/*/findings/*/review",
    async (route) => {
      const payload = (await route.request().postDataJSON()) as {
        assessment: "supported" | "partial" | "unsupported";
        reason: string;
      };
      const previous = findingReviews.at(-1);
      const row = {
        id: `finding-review-${findingReviews.length + 1}`,
        run_id: runPayload.id,
        step_id: "step-1",
        finding_index: 0,
        finding_hash: `sha256:${"d".repeat(64)}`,
        assessment: payload.assessment,
        reason: payload.reason,
        version: findingReviews.length + 1,
        supersedes_id: previous?.id ?? null,
        reviewed_by: "local-user",
        created_at: "2026-07-10T09:12:00.000Z",
      };
      findingReviews.push(row);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(row),
      });
    },
  );
  await page.route(
    "**/aletheia/matters/*/litigation/agent-runs/*/review",
    (route) => {
      const review = {
        id: "agent-review-1",
        run_id: runPayload.id,
        matter_id: state.matterId,
        user_id: "local-user",
        output_hash: `sha256:${"b".repeat(64)}`,
        snapshot_hash: snapshotHash,
        status: "open",
        requested_by: "local-user",
        decision_comment: null,
        decided_by: null,
        independent_review: 0,
        decided_at: null,
        created_at: "2026-07-10T09:10:00.000Z",
      };
      agentReviews = [review];
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(review),
      });
    },
  );
  await page.route(
    "**/aletheia/matters/*/litigation/agent-output-reviews/*/decision",
    async (route) => {
      const payload = (await route.request().postDataJSON()) as {
        decision: "approved" | "rejected";
        comment: string;
      };
      const decided = {
        ...agentReviews[0],
        status: payload.decision,
        decision_comment: payload.comment,
        decided_by: "local-user",
        independent_review: 0,
        decided_at: "2026-07-10T09:15:00.000Z",
      };
      agentReviews = [decided];
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(decided),
      });
    },
  );
  await page.route(
    "**/aletheia/durable-runs/run-snapshot-1/integrity",
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          eventCount: 1,
          lastHash: "event-hash",
        }),
      }),
  );
  await page.route(
    "**/aletheia/matters/*/litigation-durable-runs/run-snapshot-1/synthesis",
    (route) => {
      persistedRun = {
        ...runPayload,
        id: "run-synthesis-1",
        goal: "Prepare a reviewed cross-partition litigation synthesis.",
        metadata: {
          ...runPayload.metadata,
          executionMode: "reviewed_synthesis",
          partitionCount: 1,
          snapshotHash: `sha256:${"c".repeat(64)}`,
          synthesisOfRunId: runPayload.id,
        },
      };
      agentReviews = [];
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify(persistedRun),
      });
    },
  );
  await page.route(
    "**/aletheia/durable-runs/run-synthesis-1/integrity",
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          eventCount: 1,
          lastHash: "synthesis-event-hash",
        }),
      }),
  );

  await page.goto(state.matterUrl);
  await page.goto(`${state.matterUrl}?view=agent`);
  await expect(page.getByText("Executor ready")).toBeVisible();
  await page
    .getByPlaceholder("e.g. payment due date, service, limitation period")
    .fill("payment due date");
  await page.getByRole("button", { name: "Start case analysis" }).click();
  await expect(
    page.getByText("Input policy confirmed cited no open review"),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Source-partitioned execution · 3 bounded partitions · no automatic whole-matter synthesis",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Ordering focus: payment due date · deterministic lexical score · all source-bound items retained",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Excluded: 1 uncited facts, 2 uncited positions, 1 positions under review",
    ),
  ).toBeVisible();
  await expect(page.getByText(`snapshot ${snapshotHash}`)).toBeVisible();
  await expect(
    page.getByText(
      "Citation IDs and exact quotes verified · 1 finding · 1 source",
    ),
  ).toBeVisible();
  await expect(page.getByText("Event chain verified")).toBeVisible();
  await expect(page.getByText("Human legal review required")).toBeVisible();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByText("Legal review open")).toBeVisible();
  await expect(
    page.getByText("The payment due date is supported by the cited contract."),
  ).toBeVisible();
  await page.getByLabel("Finding 1 assessment").selectOption("partial");
  await page
    .getByLabel("Finding 1 review reason")
    .fill("The quote supports only part of the drafted conclusion.");
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(page.getByText(/Current: partial · v1/)).toBeVisible();
  await page.getByLabel("Finding 1 assessment").selectOption("supported");
  await page
    .getByLabel("Finding 1 review reason")
    .fill("The complete exact quote supports the bounded conclusion.");
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(page.getByText(/Current: supported · v2/)).toBeVisible();
  await page
    .getByPlaceholder("Review reason (10 characters minimum)")
    .fill("The exact quotes support the bounded findings.");
  await page.getByRole("button", { name: "Adopt findings" }).click();
  await expect(
    page.getByText("Findings adopted after legal review"),
  ).toBeVisible();
  await expect(page.getByText("Non-independent review")).toBeVisible();

  await page.reload();
  await page.goto(`${state.matterUrl}?view=agent`);
  await expect(page.getByText(`snapshot ${snapshotHash}`)).toBeVisible();
  await expect(page.getByText("Event chain verified")).toBeVisible();
  await expect(
    page.getByText("Findings adopted after legal review"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Prepare reviewed synthesis" })
    .click();
  await expect(
    page.getByText("Prepare a reviewed cross-partition litigation synthesis."),
  ).toBeVisible();
  await expect(page.getByText("Human legal review required")).toBeVisible();
  await expect(
    page.getByText(`snapshot sha256:${"c".repeat(64)}`),
  ).toBeVisible();

  await page.reload();
  await page.goto(`${state.matterUrl}?view=agent`);
  await expect(
    page.getByText("Prepare a reviewed cross-partition litigation synthesis."),
  ).toBeVisible();
  await expect(page.getByText("Human legal review required")).toBeVisible();

  const bodyOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(bodyOverflow).toBe(false);
});

test("counsel exports and signs a hash-bound litigation matter audit package", async ({
  page,
}, testInfo) => {
  const seedState = fixture(testInfo.project.name);
  const apiBase = `http://127.0.0.1:${seedState.backendPort}`;
  const mobile = testInfo.project.name === "mobile-chromium";
  await page.setViewportSize(
    mobile ? { width: 393, height: 852 } : { width: 1440, height: 1000 },
  );

  const matterResponse = await page.request.post(
    `${apiBase}/aletheia/matters`,
    {
      data: {
        title: `Audit package visual regression ${testInfo.project.name}`,
        objective:
          "Verify exact litigation matter handoff and counsel sign-off.",
        template: "civil_litigation",
        status: "needs_review",
        riskLevel: "high",
        clientOrProject: "Synthetic audit package matter",
        sharedWith: [],
        metadata: { uiAudit: true },
      },
    },
  );
  expect(matterResponse.status()).toBe(201);
  const matter = (await matterResponse.json()) as { id: string };
  const matterUrl = `/aletheia/matters/${matter.id}/litigation?view=artifacts`;
  await page.goto(matterUrl);
  const auditSection = page.getByTestId("litigation-audit-package");
  await expect(auditSection).toBeVisible();
  await expect(
    auditSection.getByText("Action required", { exact: true }),
  ).toBeVisible();
  await expect(
    auditSection.getByTestId("audit-checklist").locator(":scope > div"),
  ).toHaveCount(8);
  await expect(
    auditSection.getByRole("button", { name: "Request approval" }),
  ).toBeDisabled();

  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-12-signoff-anchor",
  );
  mkdirSync(screenshotDir, { recursive: true });
  if (!mobile) {
    await alignAuditSection(page, auditSection);
    await assertAuditVisualIntegrity(page);
    await page.screenshot({
      path: path.join(
        screenshotDir,
        "01-action-required-checklist-1440x1000.png",
      ),
      animations: "disabled",
      scale: "css",
    });
  }

  const sourceText =
    "The executed agreement fixed payment on 1 September 2026. Counsel relies on Article 509 for performance as agreed.";
  const upload = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/documents`,
    {
      multipart: {
        file: {
          name: "executed-agreement.txt",
          mimeType: "text/plain",
          buffer: Buffer.from(sourceText),
        },
      },
    },
  );
  expect(upload.status()).toBe(201);
  const sourceIndexResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${matter.id}/v1/source-index?includeChunks=true&includeEvidenceLinks=true&chunkLimit=20`,
  );
  expect(sourceIndexResponse.ok()).toBe(true);
  const sourceIndex = (await sourceIndexResponse.json()) as {
    chunks: Array<{ id: string; text: string }>;
  };
  const chunk = sourceIndex.chunks.find((item) =>
    item.text.includes("payment on 1 September 2026"),
  );
  expect(chunk).toBeTruthy();
  const agreementQuote = "payment on 1 September 2026";
  const quoteStart = chunk!.text.indexOf(agreementQuote);
  const source = {
    sourceChunkId: chunk!.id,
    quoteStart,
    quoteEnd: quoteStart + agreementQuote.length,
  };

  const factResponse = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/facts`,
    {
      data: {
        statement: "Payment was fixed for 1 September 2026.",
        occurredAt: "2026-09-01T00:00:00+08:00",
        datePrecision: "day",
        helpfulness: "helpful",
        confidence: "high",
        sourceRelation: "supports",
        source,
      },
    },
  );
  expect(factResponse.status()).toBe(201);
  const fact = (await factResponse.json()) as { id: string };
  const factDecision = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/facts/${fact.id}/decision`,
    {
      data: {
        decision: "confirmed",
        comment: "Counsel checked the executed agreement text.",
      },
    },
  );
  expect(factDecision.ok()).toBe(true);

  const claimResponse = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/claims`,
    {
      data: {
        kind: "defense",
        title: "The payment defense follows the agreed performance date.",
        legalBasis: "Contract performance rule",
        confidence: "high",
        sourceRelation: "supports",
        source,
      },
    },
  );
  expect(claimResponse.status()).toBe(201);
  const claim = (await claimResponse.json()) as { id: string };
  const claimDecision = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/claims/${claim.id}/decision`,
    {
      data: {
        decision: "confirmed",
        comment: "Counsel confirmed the source-bound defense position.",
      },
    },
  );
  expect(claimDecision.ok()).toBe(true);

  const authorityQuote =
    "requires each party to perform its obligations as agreed";
  const authorityResponse = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/legal-authorities`,
    {
      data: {
        authorityType: "statute",
        title: "Civil Code",
        issuer: "National People's Congress",
        officialIdentifier: `AUDIT-509-${testInfo.project.name}`,
        versionLabel: "2021 effective text",
        sourceReference: "Official legislative publication",
        content: `Article 509 ${authorityQuote}.`,
        effectiveFrom: "2021-01-01",
        effectiveTo: null,
      },
    },
  );
  expect(authorityResponse.status()).toBe(201);
  const authority = (await authorityResponse.json()) as { id: string };
  const verifyAuthority = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/legal-authorities/${authority.id}/verify`,
    {
      data: {
        comment:
          "Counsel compared the stored provision and effective date with the official publication.",
      },
    },
  );
  expect(verifyAuthority.ok()).toBe(true);
  const linkAuthority = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/position-authorities`,
    {
      data: {
        claimId: claim.id,
        authorityVersionId: authority.id,
        applicabilityDate: "2026-09-01",
        provisionReference: "Article 509",
        exactQuote: authorityQuote,
        rationale:
          "The provision directly supports applying the agreed performance date to the defense.",
      },
    },
  );
  expect(linkAuthority.status()).toBe(201);

  for (const kind of [
    "evidence_catalog",
    "claim_defense_matrix",
    "procedural_clock",
    "litigation_brief",
    "hearing_plan",
  ]) {
    const artifactResponse = await page.request.post(
      `${apiBase}/aletheia/matters/${matter.id}/litigation/artifacts/${kind}`,
    );
    expect(artifactResponse.status()).toBe(201);
    const artifact = (await artifactResponse.json()) as {
      validation_errors: unknown[];
      stale_at: string | null;
    };
    expect(artifact.validation_errors).toEqual([]);
    expect(artifact.stale_at).toBeNull();
  }

  await auditSection
    .getByRole("button", { name: "Refresh audit package status" })
    .click();
  await expect(auditSection.getByText("Ready", { exact: true })).toBeVisible();
  const previewResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/audit-exports/preview`,
  );
  expect(previewResponse.ok()).toBe(true);
  const preview = (await previewResponse.json()) as {
    matter_state_hash: string;
    checklist_hash: string;
    checklist: { schema_version: string; overall_status: string };
    attestation: string;
  };
  expect(preview.checklist.overall_status).toBe("ready");

  const wrongApproval = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/approvals`,
    {
      data: {
        action: "litigation_matter_audit_export",
        prompt: "This deliberately binds the wrong matter hash.",
        requestedPayload: {
          matterStateHash: `sha256:${"0".repeat(64)}`,
          checklistHash: preview.checklist_hash,
          checklistSchemaVersion: preview.checklist.schema_version,
        },
      },
    },
  );
  expect(wrongApproval.ok()).toBe(false);
  expect((await wrongApproval.json()).detail).toMatch(/current matter state/i);

  await auditSection.getByRole("button", { name: "Request approval" }).click();
  await expect(auditSection.getByText("open", { exact: true })).toBeVisible();
  await auditSection
    .getByRole("button", { name: "Approve exact snapshot" })
    .click();
  await expect(
    auditSection.getByText("approved", { exact: true }),
  ).toBeVisible();
  await auditSection
    .getByRole("button", { name: "Create verified package" })
    .click();
  await expect(
    auditSection.getByText("Integrity verified", { exact: true }),
  ).toBeVisible();
  await expect(
    auditSection.getByText("approved and exported", { exact: true }),
  ).toBeVisible();
  await expect(
    auditSection.getByRole("button", { name: "Create verified package" }),
  ).toHaveCount(0);
  await expect(
    auditSection.getByRole("button", { name: "Request approval" }),
  ).toHaveCount(0);
  const exportHashText = auditSection.getByText(/^sha256:[a-f0-9]{64}$/).last();
  await expect(exportHashText).toBeVisible();

  if (!mobile) {
    await page.setViewportSize({ width: 900, height: 1000 });
    await alignAuditSection(page, auditSection);
    await assertAuditVisualIntegrity(page);
    await page.screenshot({
      path: path.join(screenshotDir, "02-ready-approved-exported-900x1000.png"),
      animations: "disabled",
      scale: "css",
    });
  }

  const exportsResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/audit-exports`,
  );
  expect(exportsResponse.ok()).toBe(true);
  const exportSummary = (
    (await exportsResponse.json()) as Array<{
      export_id: string;
      export_hash: string;
      matter_state_hash: string;
      checklist_hash: string;
      stale: boolean;
    }>
  )[0];
  expect(exportSummary.stale).toBe(false);

  await page.reload();
  const persistedAuditSection = page.getByTestId("litigation-audit-package");
  await expect(
    persistedAuditSection.getByText("Integrity verified", { exact: true }),
  ).toBeVisible();
  await expect(
    persistedAuditSection.getByText("approved and exported", { exact: true }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await persistedAuditSection
    .getByRole("button", { name: "Download verified JSON" })
    .click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const downloadedPackage = JSON.parse(readFileSync(downloadPath!, "utf8")) as {
    export_id: string;
    export_hash: string;
    matter_state_hash: string;
    checklist_hash: string;
  };
  expect(downloadedPackage.export_id).toBe(exportSummary.export_id);
  expect(downloadedPackage.export_hash).toBe(exportSummary.export_hash);
  expect(downloadedPackage.matter_state_hash).toBe(
    exportSummary.matter_state_hash,
  );
  expect(downloadedPackage.checklist_hash).toBe(exportSummary.checklist_hash);

  await persistedAuditSection.getByLabel("Signer name").fill("Counsel Li");
  await persistedAuditSection
    .getByLabel("Professional ID (optional)")
    .fill("Synthetic-001");
  await persistedAuditSection.getByLabel("Review comment").fill("too short");
  const signButton = persistedAuditSection.getByRole("button", {
    name: "Record counsel sign-off",
  });
  await expect(signButton).toBeDisabled();
  await persistedAuditSection
    .getByLabel(/I accept this exact attestation/)
    .check();
  await expect(signButton).toBeDisabled();
  await persistedAuditSection
    .getByLabel("Review comment")
    .fill(
      "I reviewed every readiness item and the exact package hashes before sign-off.",
    );
  await expect(signButton).toBeEnabled();
  await signButton.click();
  const receipts = persistedAuditSection.getByTestId("audit-signoff-receipts");
  await expect(receipts).toContainText("Counsel Li");
  await expect(receipts).toContainText("Valid");
  await expect(receipts).toContainText("Current");
  await expect(receipts).toContainText("No");
  const anchorProof = receipts.locator(
    "[data-testid^='audit-signoff-anchor-']",
  );
  const signoffId = (await anchorProof.getAttribute("data-testid"))!.replace(
    "audit-signoff-anchor-",
    "",
  );
  await expect(anchorProof).toContainText("Not anchored");
  const anchorButton = anchorProof.getByRole("button", {
    name: "Anchor exact audit head (admin)",
  });
  await expect(anchorButton).toBeVisible();
  await anchorButton.click();
  await expect(anchorProof).toContainText("Exact audit-head coverage verified");
  await expect(anchorProof).toContainText("Anchor index");
  await expect(anchorProof).toContainText("Ed25519 key_id");
  await expect(anchorProof).toContainText("Anchored at");
  await expect(
    anchorProof.getByText("Anchor hash", { exact: true }),
  ).toBeVisible();
  await expect(anchorButton).toHaveCount(0);

  const proofResponse = await page.request.get(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/audit-exports/${exportSummary.export_id}/signoffs/${signoffId}/anchor-proof`,
  );
  expect(proofResponse.ok()).toBe(true);
  const proof = (await proofResponse.json()) as {
    configured: boolean;
    anchored: boolean;
    can_anchor: boolean;
    coverage: {
      anchor_index: number;
      anchor_hash: string;
      key_id: string;
      anchored_at: string;
      signature_algorithm: string;
    } | null;
  };
  expect(proof.configured).toBe(true);
  expect(proof.anchored).toBe(true);
  expect(proof.can_anchor).toBe(false);
  expect(proof.coverage?.anchor_index).toBeGreaterThanOrEqual(0);
  expect(proof.coverage?.anchor_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(proof.coverage?.key_id).toMatch(/^[a-f0-9]{24,64}$/);
  expect(proof.coverage?.anchored_at).toBeTruthy();
  expect(proof.coverage?.signature_algorithm).toBe("ed25519");

  if (!mobile) {
    await page.setViewportSize({ width: 900, height: 1100 });
    await alignAuditSection(page, anchorProof);
    await assertAnchorReceiptGeometry(page, anchorProof);
    await assertAuditVisualIntegrity(page);
    await page.screenshot({
      path: path.join(screenshotDir, "01-anchored-receipt-900x1100.png"),
      animations: "disabled",
      scale: "css",
    });
  }

  const changedMatter = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/facts`,
    {
      data: {
        statement: "A later proposed fact changes the current matter snapshot.",
        datePrecision: "unknown",
        helpfulness: "unknown",
        confidence: "low",
      },
    },
  );
  expect(changedMatter.status()).toBe(201);
  await persistedAuditSection
    .getByRole("button", { name: "Refresh audit package status" })
    .click();
  await expect(
    persistedAuditSection.getByText("Stale: matter changed", { exact: true }),
  ).toBeVisible();
  const refreshedApprovalButton = persistedAuditSection.getByRole("button", {
    name: "Request approval",
  });
  await expect(refreshedApprovalButton).toBeVisible();
  await expect(refreshedApprovalButton).toBeEnabled();
  await expect(receipts).toContainText("Stale");
  await expect(signButton).toBeDisabled();
  await expect(
    persistedAuditSection.getByRole("button", {
      name: "Download verified JSON",
    }),
  ).toBeDisabled();

  const staleSignoff = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/audit-exports/${exportSummary.export_id}/signoffs`,
    {
      data: {
        exportHash: exportSummary.export_hash,
        checklistHash: exportSummary.checklist_hash,
        matterStateHash: exportSummary.matter_state_hash,
        signerName: "Counsel Chen",
        professionalIdentifier: null,
        attestation: preview.attestation,
        comment:
          "A stale historical package must not receive another counsel sign-off.",
      },
    },
  );
  expect(staleSignoff.ok()).toBe(false);
  expect((await staleSignoff.json()).detail).toMatch(/stale|hashes differ/i);

  const anchorConflict = await page.request.post(
    `${apiBase}/aletheia/matters/${matter.id}/litigation/audit-exports/${exportSummary.export_id}/signoffs/${signoffId}/anchor`,
  );
  expect(anchorConflict.status()).toBe(409);
  expect(await anchorConflict.json()).toMatchObject({
    code: "audit_anchor_head_advanced",
  });
  await expect(anchorProof).toContainText("Exact audit-head coverage verified");
  await expect(receipts).toContainText("Stale");

  if (mobile) {
    await alignAuditSection(page, anchorProof);
    await assertAnchorReceiptGeometry(page, anchorProof);
    await assertAuditVisualIntegrity(page);
    await page.screenshot({
      path: path.join(screenshotDir, "02-stale-anchored-receipt-393x852.png"),
      animations: "disabled",
      scale: "css",
    });
  }

  await expect(persistedAuditSection).toContainText(
    "This is not a qualified electronic signature, trusted timestamp, or independent notarization.",
  );
});
