import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  WORKSPACE_BACKEND_ERROR_CODES,
  WORKSPACE_ERROR_MESSAGE_KEYS,
  backendErrorMessageKey,
  localizeBackendError,
} from "../src/app/i18n/errors.ts";
import {
  formatDate,
  formatFileSize,
  formatNumber,
} from "../src/app/i18n/formatters.ts";
import { DEFAULT_LOCALE } from "../src/app/i18n/locales.ts";
import {
  MESSAGES,
  translateMessage,
} from "../src/app/i18n/messages.ts";

function flattenKeys(
  value: unknown,
  prefix = "",
): string[] {
  if (typeof value === "string") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function flattenMessages(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Object.values(value as Record<string, unknown>).flatMap((child) =>
    flattenMessages(child),
  );
}

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const absolute = path.join(root, entry);
    if (statSync(absolute).isDirectory()) return sourceFiles(absolute);
    return /\.(?:ts|tsx)$/.test(entry) ? [absolute] : [];
  });
}

function withoutComments(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("Vera dictionaries are complete, Chinese-first, and cover the desktop product", () => {
  expect(DEFAULT_LOCALE).toBe("zh-CN");

  const zhKeys = flattenKeys(MESSAGES["zh-CN"]).sort();
  const enKeys = flattenKeys(MESSAGES["en-US"]).sort();
  expect(enKeys).toEqual(zhKeys);

  expect(zhKeys).toEqual(expect.arrayContaining([
    "nav.assistant",
    "nav.matters",
    "nav.workflows",
    "nav.review",
    "nav.settings",
    "matters.profile.classificationRequired",
    "matters.capabilities.inferenceClosed",
    "matters.capabilities.readOnly",
    "matters.navigation.drafts",
    "projects.empty.title",
    "projects.deleteConfirm.action",
    "documents.empty.title",
    "documents.deleteConfirm.action",
    "assistant.empty.title",
    "workflows.empty.title",
    "tabular.empty.title",
    "settings.language.title",
    "workspace.localOnly",
    "workspace.resetConfirm.action",
  ]));

  const userCopy = [
    ...flattenMessages(MESSAGES["zh-CN"]),
    ...flattenMessages(MESSAGES["en-US"]),
  ].join("\n");
  expect(userCopy).not.toMatch(/\b(?:mike|aletheia|supabase)\b/i);
  expect(userCopy).toContain("Vera");
  expect(translateMessage("zh-CN", "projects.deleteConfirm.namePrompt", { name: "证据审查" }))
    .toContain("证据审查");
});

test("stable backend error codes always resolve to localized safe copy", () => {
  expect(Object.keys(WORKSPACE_ERROR_MESSAGE_KEYS).sort())
    .toEqual([...WORKSPACE_BACKEND_ERROR_CODES].sort());

  for (const code of WORKSPACE_BACKEND_ERROR_CODES) {
    const key = backendErrorMessageKey(code);
    expect(key).not.toBe("errors.unknown");
    expect(localizeBackendError(code, (messageKey, values) =>
      translateMessage("zh-CN", messageKey, values))).toBe(
      translateMessage("zh-CN", key),
    );
  }

  const internalBackendMessage = "Document blob cleanup is pending.";
  const localized = localizeBackendError(
    {
      code: "UNRECOGNIZED_CODE",
      status: 500,
      message: internalBackendMessage,
    },
    (messageKey, values) => translateMessage("zh-CN", messageKey, values),
  );
  expect(localized).toBe(MESSAGES["zh-CN"].errors.internal);
  expect(localized).not.toContain(internalBackendMessage);
});

test("capability copy describes the real Assistant, Workflow, and Tabular surfaces", () => {
  expect(MESSAGES["zh-CN"].projects.subtitle).toContain("创建项目");
  expect(MESSAGES["zh-CN"].documents.subtitle).toContain("管理项目资料");
  expect(MESSAGES["en-US"].projects.subtitle).toContain("Create projects");
  expect(MESSAGES["en-US"].documents.subtitle).toContain(
    "Manage project materials",
  );

  expect(MESSAGES["zh-CN"].assistant.subtitle).toContain("本地可恢复的对话");
  expect(MESSAGES["zh-CN"].workflows.subtitle).toContain("本地持久执行");
  expect(MESSAGES["zh-CN"].tabular.subtitle).toContain("批量提取结构化结果");
  expect(MESSAGES["en-US"].assistant.subtitle).toContain("durable local conversations");
  expect(MESSAGES["en-US"].workflows.subtitle).toContain("run them durably");
  expect(MESSAGES["en-US"].tabular.subtitle).toContain("Extract structured results");

  const capabilityCopy = [
    ...flattenMessages(MESSAGES["zh-CN"]),
    ...flattenMessages(MESSAGES["en-US"]),
  ].join("\n");
  expect(capabilityCopy).not.toMatch(
    /后续版本启用|尚未启用|本版本未启用|当前版本未启用|later release|not enabled (?:yet|in this (?:release|version))/i,
  );

  expect(
    localizeBackendError("REMOTE_PROVIDER_DISABLED", (key, values) =>
      translateMessage("zh-CN", key, values),
    ),
  ).toBe("当前运行环境不提供远程模型调用。");
  expect(MESSAGES["en-US"].errors.remoteDisabled).toBe(
    "This runtime does not provide remote model calls.",
  );
});

test("P0 product sources keep user copy in i18n dictionaries", () => {
  const sourceRoot = path.join(process.cwd(), "src", "app");
  const roots = [
    path.join(process.cwd(), "src", "features", "matter-overview"),
    path.join(sourceRoot, "components", "assistant"),
    path.join(sourceRoot, "components", "models"),
    path.join(sourceRoot, "components", "projects"),
    path.join(sourceRoot, "components", "tabular"),
    path.join(sourceRoot, "components", "vera-shell"),
    path.join(sourceRoot, "components", "workflows"),
    path.join(sourceRoot, "(pages)", "assistant"),
    path.join(sourceRoot, "(pages)", "matters"),
    path.join(sourceRoot, "(pages)", "projects"),
    path.join(sourceRoot, "(pages)", "settings"),
    path.join(sourceRoot, "(pages)", "tabular-review"),
    path.join(sourceRoot, "(pages)", "workflows"),
  ];
  const explicitFiles = [
    path.join(sourceRoot, "hooks", "useAssistantChat.ts"),
    path.join(sourceRoot, "components", "shared", "ConfirmPopup.tsx"),
    path.join(sourceRoot, "components", "shared", "Modal.tsx"),
    path.join(sourceRoot, "components", "shared", "RowActions.tsx"),
  ];
  const persistedCompatibilityValues = new Set([
    path.join(sourceRoot, "components", "tabular", "pillUtils.ts"),
    path.join(sourceRoot, "components", "workflows", "VeraWorkflowFormModal.tsx"),
  ]);

  const files = [...new Set([...roots.flatMap(sourceFiles), ...explicitFiles])];
  for (const file of files) {
    const source = withoutComments(readFileSync(file, "utf8"));
    if (!persistedCompatibilityValues.has(file)) {
      expect(source, `${path.relative(process.cwd(), file)} has hard-coded Han copy`)
        .not.toMatch(/[\u3400-\u9fff]/);
    }

    const brandAuditedSource = file.endsWith(
      path.join("settings", "data", "page.tsx"),
    )
      ? source
          .replaceAll("AletheiaDesktopInfo", "DesktopInfo")
          .replaceAll("aletheiaDesktop", "desktopBridge")
      : source;
    expect(
      brandAuditedSource,
      `${path.relative(process.cwd(), file)} contains a legacy product brand`,
    ).not.toMatch(/\b(?:mike|aletheia|supabase)\b/i);
  }
});

test("date, number, and file-size formatting is delegated to Intl", () => {
  const instant = new Date("2026-07-14T00:00:00.000Z");
  const dateOptions = { dateStyle: "medium", timeZone: "UTC" } as const;
  expect(formatDate(instant, "zh-CN", dateOptions)).toBe(
    new Intl.DateTimeFormat("zh-CN", dateOptions).format(instant),
  );
  expect(formatNumber(1234567.89, "en-US", { maximumFractionDigits: 1 })).toBe(
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(1234567.89),
  );
  expect(formatFileSize(1536, "zh-CN")).toBe(
    new Intl.NumberFormat("zh-CN", {
      style: "unit",
      unit: "kilobyte",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(1.5),
  );
  expect(formatDate("not-a-date", "zh-CN")).toBe("—");
  expect(formatFileSize(-1, "zh-CN")).toBe("—");
});

test("brand primitives use Vera assets and expose accessible names", () => {
  const sourceRoot = path.join(process.cwd(), "src", "app");
  const rootLayoutSource = readFileSync(
    path.join(sourceRoot, "layout.tsx"),
    "utf8",
  );
  const markSource = readFileSync(
    path.join(sourceRoot, "components", "vera-brand", "VeraMark.tsx"),
    "utf8",
  );
  const logoSource = readFileSync(
    path.join(sourceRoot, "components", "vera-brand", "VeraLogo.tsx"),
    "utf8",
  );
  const providerSource = readFileSync(
    path.join(sourceRoot, "i18n", "I18nProvider.tsx"),
    "utf8",
  );

  expect(markSource).toContain('src="/vera-mark.png"');
  expect(`${markSource}\n${logoSource}`).not.toMatch(/(?:mike|aletheia)-?(?:logo|mark)/i);
  expect(markSource).toContain("alt={decorative ? \"\" : label}");
  expect(logoSource).toContain('role="img"');
  expect(logoSource).toContain("aria-label={label}");
  expect(providerSource).toContain("initialLocale = DEFAULT_LOCALE");
  expect(providerSource).toContain("document.documentElement.lang = locale");
  expect(rootLayoutSource).toContain('<html lang="zh-CN">');
  expect(rootLayoutSource).toContain('title: "Vera"');
  expect(rootLayoutSource).toContain('siteName: "Vera"');
  expect(rootLayoutSource).toContain('url: "/vera-mark.png"');
  expect(rootLayoutSource).not.toMatch(/icon\.svg|mike|aletheia|supabase/i);

  expect(readdirSync(path.join(process.cwd(), "public")).sort()).toEqual([
    "vera-mark.png",
    "vera-wordmark.png",
  ]);
});
