import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

const benchmarkFixtureEnabled = process.env.ALETHEIA_BENCHMARK_FIXTURE === "1";
const benchmarkRuntimePort = Number(
  process.env.ALETHEIA_BENCHMARK_FIXTURE_PORT ?? 3412,
);
const benchmarkModelId = "benchmark-fixture";
const benchmarkProviderModel = "fixture-legal-model";
let benchmarkRuntime: Server | null = null;
let benchmarkFixtureFailure = false;

const benchmarkOutputs = {
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

function fixtureOutput(prompt: string) {
  if (prompt.includes("calibration-source-v1")) {
    return benchmarkOutputs.calibration;
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
    if (prompt.includes(marker)) {
      if (benchmarkFixtureFailure && caseId === "single_exact_quote") {
        return {
          ...benchmarkOutputs.single_exact_quote,
          summary: "付款事实有文书支持。",
          findings: [
            {
              ...benchmarkOutputs.single_exact_quote.findings[0],
              statement: "付款事实有文书支持。",
            },
          ],
        };
      }
      return benchmarkOutputs[caseId];
    }
  }
  throw new Error("The fixture received an unknown benchmark prompt.");
}

test.beforeAll(async () => {
  if (!benchmarkFixtureEnabled) return;
  benchmarkRuntime = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: benchmarkProviderModel }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            messages?: Array<{ content?: string }>;
          };
          const prompt = (body.messages ?? [])
            .map((message) => message.content ?? "")
            .join("\n");
          const content = JSON.stringify(fixtureOutput(prompt));
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content } }],
              usage: { completion_tokens: 160, total_tokens: 420 },
            }),
          );
        } catch (error) {
          response.statusCode = 500;
          response.end(error instanceof Error ? error.message : String(error));
        }
      });
      return;
    }
    response.statusCode = 404;
    response.end("Not found");
  });
  await new Promise<void>((resolve, reject) => {
    benchmarkRuntime?.once("error", reject);
    benchmarkRuntime?.listen(benchmarkRuntimePort, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!benchmarkRuntime) return resolve();
    benchmarkRuntime.close((error) => (error ? reject(error) : resolve()));
  });
  benchmarkRuntime = null;
});

test("client settings persist and render at desktop and narrow widths", async ({
  page,
}, testInfo) => {
  await page.goto("/aletheia/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(
    page.getByText("Synced with local settings service"),
  ).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Memory & Context" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Notifications" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Providers" })).toHaveCount(0);

  await page.getByRole("button", { name: "Models" }).click();
  await expect(
    page
      .locator(".aletheia-setting-row", { hasText: "Reasoning" })
      .locator("select"),
  ).toBeVisible();
  await expect(
    page
      .locator(".aletheia-setting-row", { hasText: "Fast mode" })
      .getByRole("button"),
  ).toBeVisible();
  const calibrationRow = page.locator(".aletheia-setting-row", {
    hasText: "Mandatory exact-quote calibration",
  });
  await expect(
    calibrationRow.getByRole("button", { name: "Run calibration" }),
  ).toBeVisible();
  await expect(page.getByTestId("local-model-benchmark")).toContainText(
    "does not replace counsel review",
  );
  const litigationRoutingRow = page.locator(".aletheia-setting-row", {
    hasText: "Litigation analysis",
  });
  const routineRoutingRow = page.locator(".aletheia-setting-row", {
    hasText: "Routine analysis",
  });
  await expect(litigationRoutingRow.locator("select")).toBeVisible();
  await expect(routineRoutingRow.locator("select")).toBeVisible();
  await expect(
    page.locator(".aletheia-setting-row", { hasText: "Routing state" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).click();
  await expect(
    page
      .locator(".aletheia-setting-row", { hasText: "Notifications" })
      .getByRole("button"),
  ).toBeVisible();
  await expect(page.getByText("Draft autosave")).toHaveCount(0);
  const voiceRow = page.locator(".aletheia-setting-row", { hasText: "Voice" });
  await expect(voiceRow).toContainText("Unavailable");
  await expect(voiceRow).toContainText("ALETHEIA_VOICE_PYTHON_PATH");

  await page.getByRole("button", { name: "Appearance" }).click();
  const theme = page
    .locator(".aletheia-setting-row", { hasText: "Theme" })
    .locator("select");
  const density = page
    .locator(".aletheia-setting-row", { hasText: "Density" })
    .locator("select");
  const sidebar = page
    .locator(".aletheia-setting-row", { hasText: "Sidebar" })
    .locator("select");
  const documentFont = page
    .locator(".aletheia-setting-row", { hasText: "Document font size" })
    .locator("select");

  await theme.selectOption("Dark");
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await density.selectOption("Compact");
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await sidebar.selectOption("Narrow");
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await documentFont.selectOption("Large");
  await expect(page.getByText(/Saved \d/)).toBeVisible();

  await expect(page.locator("html")).toHaveAttribute(
    "data-aletheia-theme",
    "dark",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-aletheia-density",
    "compact",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-aletheia-sidebar",
    "narrow",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-aletheia-document-font-size",
    "large",
  );
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.screenshot({
    path: `/tmp/aletheia-settings-${testInfo.project.name}.png`,
    fullPage: true,
  });

  await theme.selectOption("System");
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await density.selectOption("Comfortable");
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await sidebar.selectOption("Standard");
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await documentFont.selectOption("Medium");
  await expect(page.getByText(/Saved \d/)).toBeVisible();
});

test("legal source secrets fail closed and remain local to the settings form", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The owned legal-source captures cover desktop and 393px in one test.",
  );

  let pkulawHasSecret = false;
  let providersUnavailable = false;
  const requests: Array<{ method: string; url: string; body: string | null }> = [];
  await page.route("**/aletheia/providers**", async (route) => {
    const request = route.request();
    requests.push({
      method: request.method(),
      url: request.url(),
      body: request.postData(),
    });
    if (request.url().endsWith("/aletheia/providers")) {
      if (providersUnavailable) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ detail: "受控部署配置不可用" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          providers: [
            {
              provider: "pkulaw",
              hasSecret: pkulawHasSecret,
              encryptionEnabled: true,
              endpointConfigured: true,
              allowlisted: true,
              credentialReferenceConfigured: true,
            },
            {
              provider: "wolters",
              hasSecret: false,
              encryptionEnabled: true,
              endpointConfigured: false,
              allowlisted: true,
              credentialReferenceConfigured: true,
            },
            { provider: "official", hasSecret: true },
          ],
        }),
      });
      return;
    }
    if (request.method() === "PUT") {
      pkulawHasSecret = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    if (request.method() === "DELETE") {
      pkulawHasSecret = false;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.abort();
  });

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/aletheia/settings");
  await page.getByRole("button", { name: "Tools & Keys" }).click();
  const section = page.getByTestId("legal-source-settings");
  await expect(section).toContainText("法律数据源");
  await expect(section).toContainText("北大法宝");
  await expect(section).toContainText("威科先行");
  await expect(section).toContainText("未保存本地密钥");
  const pkulawInput = page.getByLabel("北大法宝本地密钥");
  const woltersInput = page.getByLabel("威科先行本地密钥");
  await expect(woltersInput).toBeDisabled();
  await expect(
    section.locator("div", { hasText: "威科先行" }).getByText("不可用").first(),
  ).toBeVisible();

  await pkulawInput.fill("local-secret-not-for-display");
  await section.getByRole("button", { name: "保存" }).first().click();
  await expect(pkulawInput).toHaveValue("");
  await expect(section).toContainText("已保存本地密钥");
  const put = requests.find((request) => request.method === "PUT");
  expect(put?.url).toMatch(/\/aletheia\/providers\/pkulaw\/secret$/);
  expect(put?.body).toBe(JSON.stringify({ secret: "local-secret-not-for-display" }));
  expect(requests.some((request) => request.url.endsWith("/test"))).toBe(false);

  await section.getByRole("button", { name: "移除" }).first().click();
  await expect(section).toContainText("未保存本地密钥");
  expect(
    requests.some(
      (request) =>
        request.method === "DELETE" &&
        request.url.endsWith("/aletheia/providers/pkulaw/secret"),
    ),
  ).toBe(true);

  const auditDir = path.resolve(
    testInfo.config.rootDir,
    "..",
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-12-legal-source-settings",
  );
  mkdirSync(auditDir, { recursive: true });
  for (const viewport of [
    { name: "desktop-1200x900", width: 1200, height: 900 },
    { name: "mobile-393x1200", width: 393, height: 1200 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      const content = document.querySelector<HTMLElement>(
        ".aletheia-settings-content",
      );
      if (content) content.scrollTop = 0;
    });
    const geometry = await page.evaluate(() => {
      const target = document
        .querySelector('[data-testid="legal-source-settings"]')
        ?.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        targetOverflow: target
          ? Math.max(0, target.right - window.innerWidth, -target.left)
          : 1,
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(0);
    expect(geometry.targetOverflow).toBe(0);
    await page.screenshot({
      path: path.join(auditDir, `${viewport.name}.png`),
      fullPage: true,
    });
  }

  providersUnavailable = true;
  await page.reload();
  await page.getByRole("button", { name: "Tools & Keys" }).click();
  await expect(section).toContainText("法律数据源配置不可用");
  await expect(page.getByLabel("北大法宝本地密钥")).toBeDisabled();
  await expect(page.getByLabel("威科先行本地密钥")).toBeDisabled();
});

test("audit anchor settings follow desktop state without exposing key paths", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The owned audit captures use the desktop Chromium project.",
  );

  await page.addInitScript(() => {
    let configuration = sessionStorage.getItem("audit-anchor-managed")
      ? {
          enabled: true,
          managedExternally: true,
          journalDirectory: "/Volumes/Compliance/Vera Audit Anchor Journal",
          keyId: null as string | null,
          status: "Enabled. Managed externally.",
        }
      : {
          enabled: false,
          managedExternally: false,
          journalDirectory: null as string | null,
          keyId: null as string | null,
          status: "Disabled.",
        };
    const desktopMock = {
      getInfo: async () => ({
        appName: "Vera",
        appVersion: "test",
        platform: "darwin",
        dataDir: "/mock/data",
        logsDir: "/mock/logs",
        apiBase: "http://127.0.0.1:3411",
      }),
      getAuditAnchorConfiguration: async () => ({ ...configuration }),
      configureAuditAnchor: async () => {
        configuration = {
          enabled: true,
          managedExternally: false,
          journalDirectory: "/Volumes/Vera Audit/Vera Audit Anchor Journal",
          keyId: "0123456789abcdef01234567ignored-tail",
          status: "Enabled.",
        };
        return {
          changed: true,
          canceled: false,
          configuration: { ...configuration },
        };
      },
      disableAuditAnchor: async () => ({
        changed: false,
        canceled: true,
        configuration: { ...configuration },
      }),
    };
    Object.defineProperty(window, "aletheiaDesktop", {
      configurable: true,
      value: desktopMock,
    });
    Object.defineProperty(window, "__setManagedAuditAnchor", {
      configurable: true,
      value: () => {
        sessionStorage.setItem("audit-anchor-managed", "1");
        configuration = {
          enabled: true,
          managedExternally: true,
          journalDirectory: "/Volumes/Compliance/Vera Audit Anchor Journal",
          keyId: null,
          status: "Enabled. Managed externally.",
        };
      },
    });
  });

  const auditDir = path.resolve(
    testInfo.config.rootDir,
    "..",
    "..",
    "docs",
    "screenshots",
    "ui-audit-2026-07-12-anchor-settings",
  );
  mkdirSync(auditDir, { recursive: true });

  const assertLayout = async () => {
    const geometry = await page.evaluate(() => {
      const row = document
        .querySelector('[data-testid="audit-anchor-settings"]')
        ?.getBoundingClientRect();
      const visibleChildren = Array.from(
        document.querySelectorAll(
          '[data-testid="audit-anchor-settings"] > *',
        ),
      )
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const overlaps = visibleChildren.some((rect, index) =>
        visibleChildren.slice(index + 1).some(
          (other) =>
            rect.left < other.right &&
            rect.right > other.left &&
            rect.top < other.bottom &&
            rect.bottom > other.top,
        ),
      );
      const controlRects = Array.from(
        document.querySelectorAll(
          '[data-testid="audit-anchor-settings"] > :first-child > *',
        ),
      )
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const controlCollision = controlRects.some((rect, index) =>
        controlRects.slice(index + 1).some(
          (other) =>
            rect.left < other.right &&
            rect.right > other.left &&
            rect.top < other.bottom &&
            rect.bottom > other.top,
        ),
      );
      return {
        documentOverflow:
          document.documentElement.scrollWidth - window.innerWidth,
        rowOverflow: row
          ? Math.max(0, row.right - window.innerWidth, -row.left)
          : 1,
        overlaps,
        controlCollision,
        mobileNavigation: (() => {
          const navigation = document.querySelector<HTMLElement>(
            ".aletheia-mobile-nav",
          );
          if (!navigation) return null;
          const style = window.getComputedStyle(navigation);
          const priorScrollLeft = navigation.scrollLeft;
          navigation.scrollLeft = 40;
          const canScroll = navigation.scrollLeft > 0;
          navigation.scrollLeft = priorScrollLeft;
          return {
            clientWidth: navigation.clientWidth,
            scrollWidth: navigation.scrollWidth,
            overflowX: style.overflowX,
            canScroll,
          };
        })(),
      };
    });
    expect(geometry.documentOverflow).toBeLessThanOrEqual(0);
    expect(geometry.rowOverflow).toBe(0);
    expect(geometry.overlaps).toBe(false);
    expect(geometry.controlCollision).toBe(false);
    if (
      geometry.mobileNavigation &&
      geometry.mobileNavigation.scrollWidth > geometry.mobileNavigation.clientWidth
    ) {
      expect(["auto", "scroll"]).toContain(
        geometry.mobileNavigation.overflowX,
      );
      expect(geometry.mobileNavigation.clientWidth).toBeLessThanOrEqual(393);
      expect(geometry.mobileNavigation.canScroll).toBe(true);
    }
  };

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/aletheia/settings");
  await page.getByRole("button", { name: "Safety" }).click();
  const anchor = page.getByTestId("audit-anchor-settings");
  const anchorRow = page.locator(".aletheia-setting-row", { has: anchor });
  await expect(anchor).toContainText("Disabled");
  await anchor.getByRole("button", { name: "Choose location" }).click();
  await expect(anchor).toContainText("Enabled");
  await expect(anchor).toContainText(
    "/Volumes/Vera Audit/Vera Audit Anchor Journal",
  );
  await expect(anchor).toContainText("0123456789abcdef01234567");
  await expect(anchor).not.toContainText("ignored-tail");
  await expect(anchor).toContainText("Ed25519 key ID");
  await expect(anchor).not.toContainText(/private[ _-]?(key|path|file|material)/i);
  await expect(anchorRow).toContainText("Operator-key local audit anchoring");
  await expect(anchorRow).toContainText(
    "independently stored, append-only journal",
  );
  await expect(anchorRow).toContainText("expose divergence");
  await expect(anchorRow).toContainText(/not a qualified electronic signature/i);
  await expect(anchorRow).toContainText("trusted timestamp");
  await expect(anchorRow).toContainText("notarization");
  await expect(anchorRow).toContainText("WORM storage");
  await assertLayout();
  await page.screenshot({
    path: path.join(auditDir, "01-enabled-desktop-1200x900.png"),
  });

  await page.evaluate(() => {
    (
      window as typeof window & { __setManagedAuditAnchor: () => void }
    ).__setManagedAuditAnchor();
  });
  await page.setViewportSize({ width: 393, height: 1200 });
  await page.reload();
  await page.getByRole("button", { name: "Safety" }).click();
  const safetyHeading = page.getByRole("heading", { name: "Safety" });
  await expect(safetyHeading).toBeVisible();
  await expect(anchor).toContainText("Enabled · managed externally");
  await expect(anchor).toContainText("launch environment controls this setting");
  await expect(anchor.getByRole("button")).toHaveCount(0);
  await expect(anchor).not.toContainText(/private[ _-]?(key|path|file|material)/i);
  await assertLayout();
  const composition = await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("h1, h2, h3")).find(
      (element) => element.textContent?.trim() === "Safety",
    )?.getBoundingClientRect();
    const anchorRow = document
      .querySelector('[data-testid="audit-anchor-settings"]')
      ?.closest(".aletheia-setting-row")
      ?.getBoundingClientRect();
    return {
      headingVisible: Boolean(
        heading && heading.top >= 0 && heading.bottom <= window.innerHeight,
      ),
      anchorVisible: Boolean(
        anchorRow &&
          anchorRow.top >= 0 &&
          anchorRow.bottom <= window.innerHeight,
      ),
    };
  });
  expect(composition.headingVisible).toBe(true);
  expect(composition.anchorVisible).toBe(true);
  await page.screenshot({
    path: path.join(auditDir, "02-managed-narrow-393x1200.png"),
  });
});

test("audit anchor reports canceled and failed desktop operations without leaking bridge details", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The audit-anchor bridge contract is covered once in desktop Chromium.",
  );

  await page.addInitScript(() => {
    const configuration = {
      enabled: false,
      managedExternally: false,
      journalDirectory: null,
      keyId: null,
      status: "Disabled.",
    };
    let attempt = 0;
    Object.defineProperty(window, "aletheiaDesktop", {
      configurable: true,
      value: {
        getInfo: async () => ({
          appVersion: "test",
          backendUrl: "http://127.0.0.1:3411",
          frontendUrl: "http://127.0.0.1:3410",
          dataDir: "/mock/data",
          logsDir: "/mock/logs",
          localClient: true,
          encryptedVolumeAttested: true,
          applicationEncryption: "required",
          databaseEncryption: "sqlcipher_required",
        }),
        getAuditAnchorConfiguration: async () => ({ ...configuration }),
        configureAuditAnchor: async () => {
          attempt += 1;
          if (attempt === 1) {
            return {
              changed: false,
              canceled: true,
              configuration: { ...configuration },
            };
          }
          throw new Error(
            "Could not read /Users/operator/.vera/audit-anchor-keys/private-key.pem: SECRET_PRIVATE_MATERIAL",
          );
        },
        disableAuditAnchor: async () => ({
          changed: false,
          canceled: false,
          configuration: { ...configuration },
        }),
      },
    });
  });

  await page.goto("/aletheia/settings");
  await page.getByRole("button", { name: "Safety" }).click();
  const anchor = page.getByTestId("audit-anchor-settings");
  const configure = anchor.getByRole("button", { name: "Choose location" });
  await configure.click();
  await expect(anchor).toContainText("Canceled · configuration unchanged");
  await configure.click();
  await expect(anchor).toContainText("Configuration failed");
  await expect(anchor).toContainText("The prior configuration is unchanged");
  await expect(anchor).not.toContainText("/Users/operator");
  await expect(anchor).not.toContainText("SECRET_PRIVATE_MATERIAL");
});

test("audit anchor has explicit loading and browser-unavailable states", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "The audit-anchor bridge contract is covered once in desktop Chromium.",
  );

  await page.addInitScript(() => {
    Object.defineProperty(window, "aletheiaDesktop", {
      configurable: true,
      value: {
        getInfo: async () => ({
          appVersion: "test",
          backendUrl: "http://127.0.0.1:3411",
          frontendUrl: "http://127.0.0.1:3410",
          dataDir: "/mock/data",
          logsDir: "/mock/logs",
          localClient: true,
          encryptedVolumeAttested: true,
          applicationEncryption: "required",
          databaseEncryption: "sqlcipher_required",
        }),
        getAuditAnchorConfiguration: () => new Promise(() => undefined),
      },
    });
  });
  await page.goto("/aletheia/settings");
  await page.getByRole("button", { name: "Safety" }).click();
  await expect(page.getByTestId("audit-anchor-settings")).toContainText("Loading");

  const browserPage = await page.context().newPage();
  await browserPage.goto("/aletheia/settings");
  await browserPage.evaluate(() => {
    delete window.aletheiaDesktop;
  });
  await browserPage.reload();
  await browserPage.getByRole("button", { name: "Safety" }).click();
  const unavailable = browserPage.getByTestId("audit-anchor-settings");
  await expect(unavailable).toContainText("Unavailable in browser");
  await expect(unavailable).toContainText("Open Vera for macOS");
  await expect(unavailable.getByRole("button")).toHaveCount(0);
});

test("diagnostic benchmark runs through the backend and survives refresh", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    !benchmarkFixtureEnabled,
    "Set ALETHEIA_BENCHMARK_FIXTURE=1 with the deterministic local model config.",
  );
  const backendPort = Number(
    process.env.ALETHEIA_UI_SMOKE_BACKEND_PORT ?? 3411,
  );
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const started = await request.post(
    `${backendUrl}/aletheia/local-models/${benchmarkModelId}/start`,
  );
  expect(started.ok()).toBe(true);

  await page.goto("/aletheia/settings");
  await page.getByRole("button", { name: "Models" }).click();
  const fallbackRow = page.locator(".aletheia-setting-row", {
    hasText: "Fallback model",
  });
  await fallbackRow.locator("select").selectOption(benchmarkModelId);
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await page
    .locator(".aletheia-setting-row", { hasText: "Runtime status" })
    .getByRole("button", { name: "Refresh" })
    .click();
  const reasoning = page
    .locator(".aletheia-setting-row", { hasText: "Reasoning" })
    .locator("select");
  if ((await reasoning.inputValue()) !== "Off") {
    await reasoning.selectOption("Off");
    await expect(page.getByText(/Saved \d/)).toBeVisible();
  }

  const calibrationRow = page.locator(".aletheia-setting-row", {
    hasText: "Mandatory exact-quote calibration",
  });
  const calibrationButton = calibrationRow.getByRole("button", {
    name: "Run calibration",
  });
  await expect(calibrationButton).toBeEnabled();
  await calibrationButton.click();
  await expect(calibrationRow).toContainText("Passed");

  const benchmark = page.getByTestId("local-model-benchmark");
  const benchmarkRow = page.locator(".aletheia-setting-row", {
    hasText: "Diagnostic multi-case benchmark",
  });
  const benchmarkButton = benchmark.getByRole("button", {
    name: /^Run benchmark(?: again)?$/,
  });
  await expect(benchmarkButton).toBeEnabled();
  await benchmarkButton.click();
  await expect(benchmark).toContainText("Diagnostic pass");
  await expect(benchmark).toContainText(
    "aletheia-local-litigation-model-benchmark-v1 · 4 cases",
  );
  await expect(benchmark).toContainText("100% · 4/4 passed");
  await expect(benchmark).toContainText(
    "This benchmark does not replace counsel review",
  );
  await expect(benchmark).toContainText("not currently an execution gate");
  await expect(
    benchmark
      .getByRole("list", { name: "Benchmark case results" })
      .getByRole("listitem"),
  ).toHaveCount(4);

  const fingerprintBeforeReload = await benchmark
    .getByText(/^sha256:/)
    .first()
    .textContent();
  await page.reload();
  await expect(page.getByTestId("local-model-benchmark")).toContainText(
    "Diagnostic pass",
  );
  await expect(
    page
      .getByTestId("local-model-benchmark")
      .getByText(fingerprintBeforeReload ?? ""),
  ).toBeVisible();

  const projection = await request.get(`${backendUrl}/aletheia/local-models`);
  expect(projection.ok()).toBe(true);
  const projectionBody = (await projection.json()) as {
    models: Array<{
      id: string;
      benchmark?: { cases?: unknown[] };
      benchmarkAcceptance?: { accepted?: boolean };
    }>;
  };
  const persisted = projectionBody.models.find(
    (model) => model.id === benchmarkModelId,
  );
  expect(persisted?.benchmark?.cases).toHaveLength(4);
  expect(persisted?.benchmarkAcceptance?.accepted).toBe(true);

  if (testInfo.project.name === "desktop-chromium") {
    const auditDir = path.resolve(
      testInfo.config.rootDir,
      "..",
      "..",
      "docs",
      "screenshots",
      "ui-audit-2026-07-11-model-benchmark",
    );
    mkdirSync(auditDir, { recursive: true });
    for (const viewport of [
      { name: "desktop-1200", width: 1200, height: 900 },
      { name: "narrow-900", width: 900, height: 900 },
      { name: "mobile-393", width: 393, height: 852 },
    ]) {
      await page.setViewportSize(viewport);
      await page
        .locator(".aletheia-setting-row", {
          hasText: "Diagnostic multi-case benchmark",
        })
        .scrollIntoViewIfNeeded();
      const metrics = await page.evaluate(() => {
        const header = document
          .querySelector(".aletheia-settings-header")
          ?.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          overflowPx: Math.max(
            0,
            document.documentElement.scrollWidth - window.innerWidth,
          ),
          header: header
            ? {
                left: Math.round(header.left),
                right: Math.round(header.right),
                width: Math.round(header.width),
                height: Math.round(header.height),
              }
            : null,
        };
      });
      console.log(`[model-benchmark-audit] ${JSON.stringify(metrics)}`);
      await page.screenshot({
        path: path.join(auditDir, `${viewport.name}.png`),
        fullPage: true,
      });
    }
  }

  benchmarkFixtureFailure = true;
  await benchmark.getByRole("button", { name: "Run benchmark again" }).click();
  await expect(benchmark).toContainText("Failed");
  await expect(benchmark).toContainText("Missing marker");
  benchmarkFixtureFailure = false;
  await benchmark.getByRole("button", { name: "Run benchmark again" }).click();
  await expect(benchmark).toContainText("Diagnostic pass");

  await reasoning.selectOption("Low");
  await expect(benchmark).toContainText("Stale");
  await expect(benchmarkRow).toContainText(
    "model revision, protocol, or execution settings changed",
  );
  await expect(
    benchmark.getByRole("button", { name: "Run benchmark again" }),
  ).toBeDisabled();
  await reasoning.selectOption("Off");
  await expect(benchmark).toContainText("Diagnostic pass");
});
