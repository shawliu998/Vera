import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

type ImportFixture = {
  matterId: string;
  matterUrl: string;
  matterTitle: string;
};

type LitigationFixture = {
  matterId: string;
  matterUrl: string;
  matterTitle: string;
};

function fixture(projectName: string) {
  const state = JSON.parse(
    readFileSync(path.join(process.cwd(), ".next-ui-smoke-state.json"), "utf8"),
  ) as { projects: Record<string, { import?: ImportFixture }> };
  const result = state.projects[projectName]?.import;
  if (!result) throw new Error(`Missing import fixture for ${projectName}`);
  return result;
}

function litigationFixture(projectName: string) {
  const state = JSON.parse(
    readFileSync(path.join(process.cwd(), ".next-ui-smoke-state.json"), "utf8"),
  ) as { projects: Record<string, { litigation?: LitigationFixture }> };
  const result = state.projects[projectName]?.litigation;
  if (!result) throw new Error(`Missing litigation fixture for ${projectName}`);
  return result;
}

function buildMultiPagePdf(labels: string[]) {
  const fontId = 3 + labels.length * 2;
  const objects = new Map<number, string>();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Count ${labels.length} /Kids [${labels
      .map((_, index) => `${3 + index * 2} 0 R`)
      .join(" ")}] >>`,
  );
  labels.forEach((label, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const escaped = label.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
    const stream = `BT /F1 28 Tf 72 700 Td (${escaped}) Tj ET`;
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    objects.set(
      contentId,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  });
  objects.set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let body = "%PDF-1.4\n% local structural fixture\n";
  const offsets = [0];
  for (let id = 1; id <= fontId; id += 1) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= fontId; id += 1) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

async function expectViewerGeometry(page: import("@playwright/test").Page) {
  const geometry = await page.getByTestId("original-evidence-viewer").evaluate(
    (viewer) => {
      const viewerRect = viewer.getBoundingClientRect();
      const controls = Array.from(
        viewer.querySelectorAll<HTMLElement>("button:not([disabled]), output"),
      );
      const collisions: string[] = [];
      controls.forEach((left, index) => {
        const leftRect = left.getBoundingClientRect();
        controls.slice(index + 1).forEach((right) => {
          if (left.parentElement === right.parentElement) return;
          const rightRect = right.getBoundingClientRect();
          const width =
            Math.min(leftRect.right, rightRect.right) -
            Math.max(leftRect.left, rightRect.left);
          const height =
            Math.min(leftRect.bottom, rightRect.bottom) -
            Math.max(leftRect.top, rightRect.top);
          if (width > 1 && height > 1) collisions.push(`${left.tagName}:${right.tagName}`);
        });
      });
      const canvas = viewer.querySelector("canvas")!;
      const canvasRect = canvas.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
        viewer: {
          left: viewerRect.left,
          right: viewerRect.right,
          top: viewerRect.top,
          bottom: viewerRect.bottom,
        },
        canvas: { width: canvasRect.width, height: canvasRect.height },
        collisions,
      };
    },
  );
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
  expect(geometry.viewer.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.viewer.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.viewer.top).toBeGreaterThanOrEqual(-1);
  expect(geometry.viewer.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  expect(geometry.canvas.width).toBeGreaterThan(100);
  expect(geometry.canvas.height).toBeGreaterThan(100);
  expect(geometry.collisions).toEqual([]);
}

test("case file importer batches files and updates the source index", async ({
  page,
}, testInfo) => {
  const state = fixture(testInfo.project.name);
  await page.goto(`/aletheia/matters/${state.matterId}`);
  await expect(
    page.getByRole("heading", { name: state.matterTitle }),
  ).toBeVisible();

  const folderInput = page.getByTestId("matter-document-folder-input");
  await expect(folderInput).toHaveAttribute("webkitdirectory", "");
  await page.getByTestId("matter-document-files-input").setInputFiles([
    {
      name: "complaint.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "The complaint alleges non-payment of the purchase price.",
      ),
    },
    {
      name: "payment-record.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "Payment record: no transfer was received by 30 June 2026.",
      ),
    },
    {
      name: "unsupported.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("not uploaded"),
    },
  ]);

  await expect(page.getByText("2 indexed", { exact: true })).toBeVisible();
  await expect(page.getByText("1 failed", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Unsupported file type", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("complaint.txt", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    page.getByText("payment-record.md", { exact: true }).last(),
  ).toBeVisible();

  await page.getByTestId("document-search-input").fill("purchase price");
  await page.getByTestId("document-search-submit").click();
  await expect(page.getByTestId("document-search-results")).toContainText(
    "complaint.txt",
  );

  await page.getByTestId("matter-document-files-input").setInputFiles({
    name: "empty-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(0),
  });
  await expect(
    page.getByText("1 needs attention", { exact: true }),
  ).toBeVisible();
  const failedDocument = page
    .getByTestId("source-map-document-row")
    .filter({ hasText: "empty-notes.txt" });
  await expect(failedDocument).toContainText("failed");
  await failedDocument
    .getByRole("button", { name: "Retry extraction" })
    .click();
  await expect(failedDocument).toContainText("1 retry attempt");

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("case file status discloses native OCR provenance and low confidence", async ({
  page,
}, testInfo) => {
  const state = litigationFixture(testInfo.project.name);
  await page.route(
    `http://127.0.0.1:3411/aletheia/matters/${state.matterId}`,
    async (route) => {
      const response = await route.fetch();
      const matter = (await response.json()) as Record<string, unknown> & {
        documents?: Array<Record<string, unknown>>;
      };
      await route.fulfill({
        response,
        contentType: "application/json",
        body: JSON.stringify({
          ...matter,
          documents: [
            ...(matter.documents ?? []),
            {
              id: "ocr-document-1",
              matter_id: state.matterId,
              user_id: "local-user",
              document_id: null,
              name: "scanned-contract.pdf",
              document_type: "pdf",
              parsed_status: "parsed",
              summary: "PAYMENT DUE 2026-09-01",
              metadata: {
                parserMetadata: {
                  parser: "pdf+apple-vision",
                  pageCount: 1,
                  textLayerPageCount: 0,
                  ocrPageCount: 1,
                  ocrEngine: "apple-vision",
                  averageOcrConfidence: 0.5,
                },
              },
              created_at: "2026-07-11T01:00:00.000Z",
              updated_at: "2026-07-11T01:00:00.000Z",
            },
          ],
        }),
      });
    },
  );
  await page.goto(state.matterUrl);
  await page.getByRole("button", { name: "Facts & Evidence" }).click();
  const row = page
    .getByTestId("matter-document-status-row")
    .filter({ hasText: "scanned-contract.pdf" });
  await expect(row).toContainText("Indexed");
  await expect(row).toContainText("Apple Vision OCR · 1 page");
  await expect(row).toContainText("average confidence 50%");
  await expect(row).toContainText(
    "verify against the original before relying on quotations",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("owner can download a stored original through the authenticated browser fallback", async ({
  page,
}, testInfo) => {
  const state = litigationFixture(testInfo.project.name);
  await page.goto(state.matterUrl);
  await page.getByRole("button", { name: "Facts & Evidence" }).click();

  const row = page.getByTestId("matter-document-status-row").first();
  const command = row.getByRole("button", {
    name: /Save and open original/,
  });
  await expect(command).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await command.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).not.toContain("/");
  await expect(row.getByRole("status")).toContainText(
    "Original saved. Open it from Downloads.",
  );
  await expect(row.getByRole("status")).toContainText(
    "No comparison was recorded.",
  );
});

test("desktop original command distinguishes busy, canceled, opened, open failure, and access failure", async ({
  page,
}, testInfo) => {
  const state = litigationFixture(testInfo.project.name);
  await page.addInitScript(() => {
    const runtime = window as Window & {
      __originalBridgeMode?: string;
    };
    runtime.__originalBridgeMode = "opened";
    Object.defineProperty(window, "aletheiaDesktop", {
      configurable: true,
      value: {
        saveOriginalMatterDocument: async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 120));
          switch (runtime.__originalBridgeMode) {
            case "canceled":
              return { saved: false, canceled: true, opened: false };
            case "open-failed":
              return {
                saved: true,
                canceled: false,
                opened: false,
                openError: "/private/raw/viewer-error",
              };
            case "failed":
              throw new Error("/private/storage/path must not be disclosed");
            default:
              return { saved: true, canceled: false, opened: true };
          }
        },
      },
    });
  });
  await page.goto(state.matterUrl);
  await page.getByRole("button", { name: "Facts & Evidence" }).click();
  const row = page.getByTestId("matter-document-status-row").first();
  const command = row.getByRole("button", {
    name: /Save and open original/,
  });

  await command.click();
  await expect(command).toBeDisabled();
  await expect(row.getByRole("status")).toContainText("Checking integrity");
  await expect(row.getByRole("status")).toContainText("saved and opened");

  await page.evaluate(() => {
    (
      window as Window & { __originalBridgeMode?: string }
    ).__originalBridgeMode = "canceled";
  });
  await command.click();
  await expect(row.getByRole("status")).toContainText("Save canceled");

  await page.evaluate(() => {
    (
      window as Window & { __originalBridgeMode?: string }
    ).__originalBridgeMode = "open-failed";
  });
  await command.click();
  await expect(row.getByRole("status")).toContainText(
    "external viewer did not open",
  );
  await expect(row.getByRole("status")).not.toContainText("/private/");

  await page.evaluate(() => {
    (
      window as Window & { __originalBridgeMode?: string }
    ).__originalBridgeMode = "failed";
  });
  await command.click();
  await expect(row.getByRole("status")).toContainText(
    "Access or integrity checks failed",
  );
  await expect(row.getByRole("status")).not.toContainText("/private/");
});

test("PDF original inspector renders, navigates, zooms, closes, fails closed, and stays comparison-neutral", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const state = litigationFixture(testInfo.project.name);
  const pdf = buildMultiPagePdf([
    "LOCAL EVIDENCE PAGE ONE",
    "LOCAL EVIDENCE PAGE TWO",
    "LOCAL EVIDENCE PAGE THREE",
  ]);
  const screenshotDir = path.resolve(
    process.cwd(),
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-12-pdf-evidence-viewer",
  );
  mkdirSync(screenshotDir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(state.matterUrl);
  await page.getByRole("button", { name: "Facts & Evidence" }).click();
  await page.getByTestId("matter-document-files-input").setInputFiles({
    name: "three-page-evidence.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  const row = page
    .getByTestId("matter-document-status-row")
    .filter({ hasText: "three-page-evidence.pdf" });
  await expect(row).toBeVisible();
  const inspect = row.getByRole("button", {
    name: "Inspect original three-page-evidence.pdf",
  });
  await expect(inspect).toBeVisible();
  await page.getByTestId("matter-document-files-input").setInputFiles({
    name: "viewer-control-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("This non-PDF retains save and open only."),
  });
  const textRow = page
    .getByTestId("matter-document-status-row")
    .filter({ hasText: "viewer-control-notes.txt" });
  await expect(textRow.getByRole("button", { name: /Save and open original/ })).toBeVisible();
  await expect(textRow.getByRole("button", { name: /Inspect original/ })).toHaveCount(0);
  await inspect.click();
  const viewer = page.getByTestId("original-evidence-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText(
    "No citation page was recorded; page 1 is the starting page.",
  );
  await expect(viewer.getByLabel("PDF page position")).toHaveText("Page 1 / 3");
  await expect(viewer).toContainText("Stored byte integrity verified before rendering.");
  await expect(viewer).toContainText("does not establish authenticity, admissibility, or safety");
  await expect(viewer).toContainText("Viewing does not record a comparison.");
  await expect(
    viewer.getByTestId("original-comparison-inspector"),
  ).toHaveCount(0);
  await expect(
    viewer.getByRole("button", { name: "Record text comparison" }),
  ).toHaveCount(0);
  const canvas = viewer.getByTestId("original-evidence-canvas");
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const target = element as HTMLCanvasElement;
        return target.width > 0 && target.height > 0;
      }),
    )
    .toBe(true);
  expect(
    await canvas.evaluate((element) => {
      const target = element as HTMLCanvasElement;
      const context = target.getContext("2d");
      if (!context) return 0;
      const pixels = context.getImageData(0, 0, target.width, target.height).data;
      let nonWhite = 0;
      for (let index = 0; index < pixels.length; index += 16) {
        if (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245) {
          nonWhite += 1;
        }
      }
      return nonWhite;
    }),
  ).toBeGreaterThan(25);
  await expectViewerGeometry(page);
  await page.screenshot({
    path: path.join(screenshotDir, "pdf-evidence-viewer-desktop-1440x1000.png"),
  });

  await viewer.getByRole("button", { name: "Next page" }).click();
  await expect(viewer.getByLabel("PDF page position")).toHaveText("Page 2 / 3");
  const widthBeforeZoom = await canvas.evaluate((element) => element.getBoundingClientRect().width);
  await viewer.getByRole("button", { name: "Zoom in" }).click();
  await expect(viewer.getByLabel("PDF zoom level")).toHaveText("125%");
  await expect.poll(() => canvas.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(widthBeforeZoom);
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();

  await page.setViewportSize({ width: 393, height: 852 });
  await page.reload();
  await page.getByRole("button", { name: "Facts & Evidence" }).click();
  const mobileInspect = page
    .getByTestId("matter-document-status-row")
    .filter({ hasText: "three-page-evidence.pdf" })
    .getByRole("button", { name: "Inspect original three-page-evidence.pdf" });
  await mobileInspect.click();
  await expect(viewer.getByLabel("PDF page position")).toHaveText("Page 1 / 3");
  await expectViewerGeometry(page);
  await page.screenshot({
    path: path.join(screenshotDir, "pdf-evidence-viewer-mobile-393x852.png"),
  });
  await viewer.getByRole("button", { name: "Close original inspector" }).click();
  await expect(viewer).toBeHidden();

  const matterResponse = await page.request.get(
    `http://127.0.0.1:3411/aletheia/matters/${state.matterId}`,
  );
  const matter = (await matterResponse.json()) as {
    documents: Array<{ id: string; name: string }>;
    auditEvents: Array<{ action: string }>;
  };
  const documentId = matter.documents.find(
    (document) => document.name === "three-page-evidence.pdf",
  )?.id;
  expect(documentId).toBeTruthy();
  const invalidPdf = Buffer.from("not a structurally valid PDF", "ascii");
  await page.route(
    `**/aletheia/matters/${state.matterId}/documents/${documentId}/original`,
    (route) =>
      route.fulfill({
        status: 200,
        body: invalidPdf,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "Content-Length, X-Aletheia-Content-Sha256",
          "content-length": String(invalidPdf.length),
          "content-type": "application/pdf",
          "x-aletheia-content-sha256": createHash("sha256").update(invalidPdf).digest("hex"),
        },
      }),
  );
  await mobileInspect.click();
  await expect(viewer.getByRole("alert")).toContainText(
    "could not be loaded after its byte integrity check",
  );
  await expect(viewer.getByTestId("original-evidence-canvas")).toHaveCSS(
    "visibility",
    "hidden",
  );
  await page.keyboard.press("Escape");

  const afterResponse = await page.request.get(
    `http://127.0.0.1:3411/aletheia/matters/${state.matterId}`,
  );
  const after = (await afterResponse.json()) as {
    auditEvents: Array<{ action: string }>;
  };
  expect(
    after.auditEvents.filter(
      (event) => event.action === "litigation_source_original_scan_verified",
    ),
  ).toHaveLength(
    matter.auditEvents.filter(
      (event) => event.action === "litigation_source_original_scan_verified",
    ).length,
  );
});
