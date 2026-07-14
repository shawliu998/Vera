import { readFileSync } from "node:fs";
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

test("Vera dictionaries are complete, Chinese-first, and cover the desktop product", () => {
  expect(DEFAULT_LOCALE).toBe("zh-CN");

  const zhKeys = flattenKeys(MESSAGES["zh-CN"]).sort();
  const enKeys = flattenKeys(MESSAGES["en-US"]).sort();
  expect(enKeys).toEqual(zhKeys);

  expect(zhKeys).toEqual(expect.arrayContaining([
    "nav.projects",
    "nav.assistant",
    "nav.workflows",
    "nav.tabular",
    "nav.settings",
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

test("capability copy distinguishes available workspace features from planned features", () => {
  expect(MESSAGES["zh-CN"].projects.subtitle).toContain("创建项目");
  expect(MESSAGES["zh-CN"].documents.subtitle).toContain("管理项目资料");
  expect(MESSAGES["en-US"].projects.subtitle).toContain("Create projects");
  expect(MESSAGES["en-US"].documents.subtitle).toContain(
    "Manage project materials",
  );

  for (const copy of [
    MESSAGES["zh-CN"].assistant.subtitle,
    ...Object.values(MESSAGES["zh-CN"].assistant.errors),
    MESSAGES["zh-CN"].workflows.subtitle,
    ...Object.values(MESSAGES["zh-CN"].workflows.errors),
    MESSAGES["zh-CN"].tabular.subtitle,
    ...Object.values(MESSAGES["zh-CN"].tabular.errors),
  ]) {
    expect(copy).toMatch(/后续版本启用|尚未启用/);
  }
  for (const copy of [
    MESSAGES["en-US"].assistant.subtitle,
    ...Object.values(MESSAGES["en-US"].assistant.errors),
    MESSAGES["en-US"].workflows.subtitle,
    ...Object.values(MESSAGES["en-US"].workflows.errors),
    MESSAGES["en-US"].tabular.subtitle,
    ...Object.values(MESSAGES["en-US"].tabular.errors),
  ]) {
    expect(copy).toMatch(/later release|not enabled yet/);
  }

  expect(
    localizeBackendError("REMOTE_PROVIDER_DISABLED", (key, values) =>
      translateMessage("zh-CN", key, values),
    ),
  ).toBe("当前版本未启用远程模型。");
  expect(MESSAGES["zh-CN"].errors.remoteDisabled).not.toMatch(/设置|本地模型/);
  expect(MESSAGES["en-US"].errors.remoteDisabled).not.toMatch(
    /Settings|local model/i,
  );
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
});
