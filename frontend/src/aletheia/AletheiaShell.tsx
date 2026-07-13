"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardList,
  Scale,
  Search,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AletheiaIcon } from "@/components/chat/aletheia-icon";
import {
  ALETHEIA_SETTINGS_EVENT,
  LAST_MATTER_KEY,
  applyAletheiaSettings,
  landingPath,
  readAletheiaSettings,
} from "./settingsModel";
import {
  AletheiaCommandPalette,
  openAletheiaCommandPalette,
} from "./AletheiaCommandPalette";
import { AletheiaNotificationCenter } from "./AletheiaNotificationCenter";
import { AletheiaDeadlineMonitor } from "./AletheiaDeadlineMonitor";

const navItems = [
  { href: "/aletheia/matters", label: "Matters", icon: Scale },
  { href: "/aletheia/tasks", label: "Work Queue", icon: ClipboardList },
];

const compatibilityRouteTitles = [
  { href: "/aletheia/templates", label: "Templates" },
  { href: "/aletheia/agentops", label: "Agent Studio" },
  { href: "/aletheia/evidence", label: "Evidence" },
  { href: "/aletheia/reviews", label: "Reviews" },
  { href: "/aletheia/audit", label: "Audit" },
];

function pageTitle(pathname: string) {
  if (pathname.includes("/litigation")) return "Litigation Workspace";
  if (/^\/aletheia\/matters\/[^/]+/.test(pathname)) return "Matter Workspace";
  return (
    navItems.find(
      (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
    )?.label ??
    compatibilityRouteTitles.find(
      (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
    )?.label ??
    (pathname === "/aletheia/settings" ? "Settings" : "Vera")
  );
}

export function AletheiaShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLocalClient = useSyncExternalStore(
    () => () => undefined,
    () => Boolean(window.aletheiaDesktop),
    () => false,
  );
  const [sidebarMode, setSidebarMode] = useState<"Standard" | "Narrow">(
    "Standard",
  );
  const [density, setDensity] = useState<"Comfortable" | "Compact">(
    "Comfortable",
  );
  const [homeHref, setHomeHref] = useState("/aletheia/matters");

  useEffect(() => {
    function syncSettings() {
      const settings = readAletheiaSettings();
      applyAletheiaSettings(settings);
      setSidebarMode(settings.sidebar);
      setDensity(settings.density);
      setHomeHref(landingPath(settings));
    }
    syncSettings();
    window.addEventListener(ALETHEIA_SETTINGS_EVENT, syncSettings);
    return () => {
      window.removeEventListener(ALETHEIA_SETTINGS_EVENT, syncSettings);
    };
  }, []);

  useEffect(() => {
    if (/^\/aletheia\/matters\/[^/]+/.test(pathname)) {
      window.localStorage.setItem(LAST_MATTER_KEY, pathname);
    }
  }, [pathname]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => applyAletheiaSettings(readAletheiaSettings());
    media.addEventListener("change", syncSystemTheme);
    return () => media.removeEventListener("change", syncSystemTheme);
  }, []);

  const narrowSidebar = sidebarMode === "Narrow";
  const navHeight = density === "Compact" ? "h-8" : "h-9";
  const currentTitle = pageTitle(pathname);

  return (
    <div
      className={cn(
        "aletheia-shell flex h-dvh w-full min-w-0 max-w-full overflow-x-hidden bg-[#f4f5f6] text-gray-950",
        density === "Compact" && "aletheia-density-compact",
      )}
    >
      <aside
        className={cn(
          "aletheia-sidebar hidden shrink-0 flex-col border-r border-gray-200 bg-[#f3f3f5] md:flex",
          narrowSidebar ? "w-16" : "w-[232px]",
        )}
      >
        <div
          className={cn(
            "aletheia-titlebar-drag flex h-[46px] shrink-0 items-center border-b border-gray-200 px-3",
            isLocalClient && !narrowSidebar && "pl-[82px]",
            narrowSidebar && "justify-center px-2",
            isLocalClient && narrowSidebar && "items-end pb-2 pt-12 h-[76px]",
          )}
        >
          <Link
            href={homeHref}
            className="aletheia-titlebar-control flex min-w-0 items-center gap-2 transition-opacity hover:opacity-75"
            title="Open home workspace"
          >
            <AletheiaIcon size={22} />
            <span
              className={cn(
                "truncate text-[17px] font-semibold leading-none text-gray-950",
                narrowSidebar && "sr-only",
              )}
            >
              Vera
            </span>
          </Link>
        </div>

        <div
          className={cn(
            "mx-3 mb-2 border-b border-gray-200 px-1 py-3",
            narrowSidebar && "sr-only",
          )}
        >
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
            <span className="text-[11px] font-semibold uppercase text-gray-700">
              Local workspace
            </span>
          </div>
          <p className="mt-1 pl-3.5 text-[11px] leading-4 text-gray-500">
            On-device data store
          </p>
        </div>

        <nav className="space-y-0.5 px-2" aria-label="Primary navigation">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/aletheia" &&
                pathname.startsWith(`${item.href}/`));
            return (
              <Link
                key={item.href}
                href={item.href}
                title={narrowSidebar ? item.label : undefined}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                  navHeight,
                  narrowSidebar && "justify-center px-0",
                  isActive
                    ? "bg-white text-gray-950 shadow-[inset_0_0_0_1px_rgba(17,24,39,0.08)]"
                    : "text-gray-600 hover:bg-black/[0.035] hover:text-gray-950",
                )}
              >
                <item.icon
                  className={cn(
                    "h-[15px] w-[15px] stroke-[1.8]",
                    isActive ? "text-gray-950" : "text-gray-500",
                  )}
                />
                <span className={cn(narrowSidebar && "sr-only")}>
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-gray-200 px-2 py-2.5">
          <Link
            href="/aletheia/settings"
            title={narrowSidebar ? "Settings" : undefined}
            aria-current={
              pathname === "/aletheia/settings" ? "page" : undefined
            }
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
              navHeight,
              narrowSidebar && "justify-center px-0",
              pathname === "/aletheia/settings"
                ? "bg-white text-gray-950 shadow-[inset_0_0_0_1px_rgba(17,24,39,0.08)]"
                : "text-gray-600 hover:bg-black/[0.035] hover:text-gray-950",
            )}
          >
            <Settings
              className={cn(
                "h-[15px] w-[15px] stroke-[1.8]",
                pathname === "/aletheia/settings"
                  ? "text-gray-950"
                  : "text-gray-500",
              )}
            />
            <span className={cn(narrowSidebar && "sr-only")}>Settings</span>
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="aletheia-titlebar-drag hidden h-[46px] shrink-0 items-center justify-between border-b border-gray-200 bg-[#fafafa] px-4 md:flex">
          <div className="w-40" />
          <div className="truncate px-4 text-center text-xs font-medium text-gray-600">
            {currentTitle}
          </div>
          <div className="flex w-40 justify-end">
            <button
              type="button"
              onClick={openAletheiaCommandPalette}
              title="Search and commands"
              className="aletheia-titlebar-control flex h-7 items-center gap-2 rounded-md border border-gray-200 bg-white px-2 text-[11px] text-gray-500 hover:border-gray-300 hover:text-gray-900"
            >
              <Search className="h-3.5 w-3.5" />
              <span>Search</span>
              <kbd className="font-sans text-[10px] text-gray-400">⌘K</kbd>
            </button>
          </div>
        </header>

        <header className="aletheia-mobile-header w-full min-w-0 max-w-full shrink-0 border-b md:hidden">
          <div className="flex h-12 items-center gap-3 px-3">
            <Link
              href={homeHref}
              className="aletheia-mobile-brand flex min-w-0 items-center gap-2 transition-opacity hover:opacity-80"
            >
              <AletheiaIcon size={24} />
              <span className="truncate text-[17px] font-semibold">Vera</span>
            </Link>
            <button
              type="button"
              onClick={openAletheiaCommandPalette}
              title="Search and commands"
              className="aletheia-mobile-search ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-md"
            >
              <Search className="h-4 w-4" />
            </button>
          </div>
          <nav
            className="aletheia-mobile-nav flex w-full min-w-0 max-w-full gap-1 overflow-x-auto border-t px-2 py-1.5"
            aria-label="Primary navigation"
          >
            {navItems.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/aletheia" &&
                  pathname.startsWith(`${item.href}/`));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs font-medium",
                    isActive
                      ? "aletheia-mobile-nav-active"
                      : "aletheia-mobile-nav-idle",
                  )}
                >
                  <item.icon className="h-3.5 w-3.5" />
                  {item.label}
                </Link>
              );
            })}
            <Link
              href="/aletheia/settings"
              aria-current={
                pathname === "/aletheia/settings" ? "page" : undefined
              }
              className={cn(
                "flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs font-medium",
                pathname === "/aletheia/settings"
                  ? "aletheia-mobile-nav-active"
                  : "aletheia-mobile-nav-idle",
              )}
            >
              <Settings className="h-3.5 w-3.5" />
              Settings
            </Link>
          </nav>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto bg-[#f8f8f9]">
          {children}
        </main>
      </div>
      <AletheiaCommandPalette />
      <AletheiaDeadlineMonitor />
      <AletheiaNotificationCenter />
    </div>
  );
}
