import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";

const LOCKED_MIKE_SHA = "e32daad5a4c64a5561e04c53ee12411e3c5e7238";
const FRONTEND_ROOT = path.resolve(__dirname, "..");
const REPOSITORY_ROOT = path.resolve(FRONTEND_ROOT, "..");

const SOURCES = {
    layout: "frontend/src/app/(pages)/layout.tsx",
    sidebar: "frontend/src/app/components/shared/AppSidebar.tsx",
    pageHeader: "frontend/src/app/components/shared/PageHeader.tsx",
    siteLogo: "frontend/src/app/components/site-logo.tsx",
    pageChrome: "frontend/src/app/contexts/PageChromeContext.tsx",
    sidebarContext: "frontend/src/app/contexts/SidebarContext.tsx",
} as const;

function upstream(sourcePath: string): string {
    return execFileSync(
        "git",
        ["show", `${LOCKED_MIKE_SHA}:${sourcePath}`],
        { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    );
}

function current(relativePath: string): string {
    return readFileSync(path.join(FRONTEND_ROOT, relativePath), "utf8");
}

function withoutPortHeader(source: string): string {
    return source.replace(
        /\/\/ Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:\n\/\/ frontend\/src\/app\/[^\n]+\n/,
        "",
    );
}

function assertInOrder(source: string, fragments: readonly string[]) {
    let cursor = 0;
    for (const fragment of fragments) {
        const next = source.indexOf(fragment, cursor);
        assert.notEqual(next, -1, `missing ordered Mike fragment: ${fragment}`);
        cursor = next + fragment.length;
    }
}

function navArray(source: string): string {
    const match = source.match(/const NAV_ITEMS = \[([\s\S]*?)\] as const;/);
    assert(match?.[1], "Vera nav array is present");
    return match[1];
}

function quotedFields(block: string, field: string): string[] {
    return [...block.matchAll(new RegExp(`${field}:\\s*"([^"]+)"`, "g"))].map(
        (match) => match[1],
    );
}

function expectedPageHeaderPort(): string {
    let source = upstream(SOURCES.pageHeader);
    source = source.replace(
        '"use client";\n',
        '"use client";\n\n// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:\n// frontend/src/app/components/shared/PageHeader.tsx\n',
    );
    source = source.replace(
        'import { cn } from "@/app/lib/utils";',
        'import { useI18n } from "@/app/i18n";\nimport { cn } from "@/lib/utils";',
    );
    source = source.replace(
        '    const title = action.title ?? "New";',
        '    const { t } = useI18n();\n    const title = action.title ?? t("common.actions.create");',
    );
    source = source.replace(
        '    const title = action.title ?? "Delete";',
        '    const { t } = useI18n();\n    const title = action.title ?? t("common.actions.delete");',
    );
    source = source.replace(
        '    const placeholder = action.placeholder ?? "Search…";',
        '    const { t } = useI18n();\n    const placeholder = action.placeholder ?? t("common.actions.search");',
    );
    source = source.replace(
        "function PageHeaderBreadcrumbs({ items }: { items: PageHeaderBreadcrumb[] }) {\n",
        'function PageHeaderBreadcrumbs({ items }: { items: PageHeaderBreadcrumb[] }) {\n    const { t } = useI18n();\n',
    );
    return source.replaceAll(
        'parent.title ?? "Back"',
        'parent.title ?? t("common.actions.back")',
    );
}

test("all shell files identify their exact locked Mike source", () => {
    assert.equal(
        execFileSync("git", ["rev-parse", LOCKED_MIKE_SHA], {
            cwd: REPOSITORY_ROOT,
            encoding: "utf8",
        }).trim(),
        LOCKED_MIKE_SHA,
    );

    for (const [file, sourcePath] of [
        ["src/app/components/vera-shell/VeraShell.tsx", SOURCES.layout],
        ["src/app/components/vera-shell/VeraSidebar.tsx", SOURCES.sidebar],
        ["src/app/components/vera-shell/PageHeader.tsx", SOURCES.pageHeader],
        ["src/app/components/vera-shell/VeraSiteLogo.tsx", SOURCES.siteLogo],
        ["src/app/contexts/PageChromeContext.tsx", SOURCES.pageChrome],
        ["src/app/contexts/SidebarContext.tsx", SOURCES.sidebarContext],
    ] as const) {
        const source = current(file);
        assert.match(source, new RegExp(LOCKED_MIKE_SHA));
        assert.ok(source.includes(sourcePath));
    }
});

test("the pages route group activates the Vera shell without cloud providers", () => {
    const source = current("src/app/(pages)/layout.tsx");
    assert.match(source, new RegExp(LOCKED_MIKE_SHA));
    assert.match(source, /frontend\/src\/app\/\(pages\)\/layout\.tsx/);
    assert.match(source, /import \{ VeraShell \} from "@\/app\/components\/vera-shell"/);
    assert.match(source, /return <VeraShell>\{children\}<\/VeraShell>/);
    assert.doesNotMatch(
        source,
        /AuthProvider|AuthContext|ChatHistory|UserProfile|Mfa|login|account|cloud/i,
    );
});

test("Mike chrome contexts are byte-equivalent after provenance comments", () => {
    assert.equal(
        withoutPortHeader(current("src/app/contexts/PageChromeContext.tsx")),
        upstream(SOURCES.pageChrome),
    );
    assert.equal(
        withoutPortHeader(current("src/app/contexts/SidebarContext.tsx")),
        upstream(SOURCES.sidebarContext),
    );
});

test("PageHeader is an exact Mike port plus path and i18n substitutions", () => {
    assert.equal(
        current("src/app/components/vera-shell/PageHeader.tsx"),
        expectedPageHeaderPort(),
    );
});

test("layout preserves Mike state, effect, provider, and DOM ordering", () => {
    const source = current("src/app/components/vera-shell/VeraShell.tsx");
    assertInOrder(source, [
        "isSidebarOpenDesktop",
        "isSidebarOpen",
        "handleResize",
        "handleSidebarToggle",
        "handleMobileActionsContainerRef",
        "<PageChromeContext.Provider",
        "<SidebarContext.Provider",
        'className="h-dvh flex flex-col bg-gray-50/80"',
        'className="flex-1 flex min-w-0 overflow-visible"',
        "<VeraSidebar",
        'className="flex-1 flex flex-col h-dvh md:overflow-hidden relative w-full"',
        'className="relative z-20 flex md:hidden items-center gap-3 overflow-visible px-4 pt-3 pb-2 shrink-0"',
        "handleMobileActionsContainerRef",
        '<main className="flex h-full w-full flex-1 flex-col overflow-y-auto md:overflow-hidden">',
        "{children}",
    ]);
    assert.match(source, /I18nProvider initialLocale=\{initialLocale\}/);
    assert.match(source, /ChatHistoryProvider/);
    assert.match(source, /SIDEBAR_STORAGE_KEY = "veraSidebarOpen"/);
    assert.match(source, /event\.key === "Escape"/);
    assert.doesNotMatch(
        source,
        /AuthContext|useAuth|useRouter|\/login|authLoading/,
    );
});

test("AppSidebar keeps Mike DOM and classes while removing cloud-only blocks", () => {
    const source = current("src/app/components/vera-shell/VeraSidebar.tsx");
    assertInOrder(source, [
        "const handleToggle = () =>",
        "fixed inset-0 z-[98] bg-gray-300/20 md:hidden",
        'id="vera-sidebar"',
        "w-64 h-[calc(100dvh-1rem)] md:h-[calc(100dvh-1.5rem)] bg-white/65",
        "my-2 ml-2 mr-0 md:my-3 md:ml-3 md:mr-0 rounded-2xl",
        "flex flex-col transition-all duration-300 absolute md:relative z-[99]",
        "items-center justify-between px-2.5 py-3",
        "<VeraSiteLogo",
        "h-9 w-9 p-2.5 items-center flex transition-colors",
        "{/* Nav items */}",
        'className="py-0.5 px-2.5"',
        "w-full h-9 flex items-center gap-3 px-2.5 py-2 rounded-md",
        "text-sm font-medium",
    ]);

    const navigation = navArray(source);
    assert.deepEqual(quotedFields(navigation, "href"), [
        "/assistant",
        "/matters",
        "/workflows",
    ]);
    assert.deepEqual(quotedFields(navigation, "labelKey"), [
        "nav.assistant",
        "nav.matters",
        "nav.workflows",
        "nav.review",
        "nav.settings",
    ]);
    assert.match(source, /t\(labelKey\)/);
    assert.match(
        source,
        /labelKey === "nav\.settings" &&\s*settingsRuntimeAvailable\s*\? "\/settings"\s*: href/,
    );
    assert.match(
        source,
        /const isAvailable = href !== null \|\| resolvedHref !== null/,
    );
    assert.match(source, /disabled=\{!isAvailable\}/);
    assert.match(source, /aria-disabled=\{!isAvailable \|\| undefined\}/);
    assert.match(source, /!isAvailable[\s\S]*text-gray-400/);
    assert.match(source, /aria-current=\{isActive \? "page" : undefined\}/);
    assert.match(
        source,
        /labelKey === "nav\.matters"[\s\S]*pathname\.startsWith\("\/projects\/"\)/,
    );
    assert.match(source, /className="mt-4 flex min-h-0 flex-1 flex-col gap-4"/);
    assert.doesNotMatch(
        source,
        /AuthContext|useAuth|UserProfile|listProjects|recentProjects|projectNames|shared_with|People|MikeIcon|mike-icon|\/aletheia/i,
    );
    assert.doesNotMatch(
        source,
        /(?:document|chat|review)_count|mockData|fixture/i,
    );
});

test("site logo retains Mike typography and sizing with only local Vera branding", () => {
    const source = current("src/app/components/vera-shell/VeraSiteLogo.tsx");
    for (const fragment of [
        'sm: "text-xl"',
        'md: "text-2xl"',
        'lg: "text-4xl"',
        'xl: "text-6xl"',
        "flex items-center gap-1.5",
        "font-light font-serif",
        "cursor-pointer hover:opacity-80 transition-opacity",
    ]) {
        assert.ok(source.includes(fragment), fragment);
    }
    assert.match(source, /<VeraMark/);
    assert.match(source, /t\("common\.appName"\)/);
    assert.match(source, /const landingHref = "\/assistant"/);
    assert.doesNotMatch(source, /mikeoss|MikeIcon|>Mike</i);
});

test("shell exposes the canonical Gate 1 IA and capability-gated Settings", () => {
    const source = [
        current("src/app/components/vera-shell/VeraShell.tsx"),
        current("src/app/components/vera-shell/VeraSidebar.tsx"),
        current("src/app/components/vera-shell/VeraSiteLogo.tsx"),
    ].join("\n");
    assert.match(current("src/app/i18n/locales.ts"), /"zh-CN"/);
    assert.match(source, /common\.actions\.open/);
    assert.match(source, /common\.actions\.close/);
    assert.doesNotMatch(source, /router\.(?:replace|push)\("\/"\)/);
    assert.doesNotMatch(source, /redirect\(/);
    assert.doesNotMatch(source, /\/aletheia/);
    assert.match(source, /"\/assistant"/);
    assert.match(source, /"\/matters"/);
    assert.match(source, /"\/projects"/);
    assert.match(source, /"\/workflows"/);
    assert.doesNotMatch(source, /"\/tabular-review"/);
    assert.match(source, /href: null, labelKey: "nav\.review"/);
    assert.equal(source.match(/"\/settings"/g)?.length, 1);
    assert.match(
        source,
        /labelKey === "nav\.settings" &&\s*settingsRuntimeAvailable\s*\? "\/settings"\s*: href/,
    );
});
