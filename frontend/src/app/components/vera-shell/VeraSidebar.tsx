"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/shared/AppSidebar.tsx
import { useState } from "react";
import {
    PanelLeft,
    MessageSquare,
    FolderOpen,
    Table2,
    Library,
    Settings,
} from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { useI18n } from "@/app/i18n";
import { cn } from "@/lib/utils";
import { VeraSiteLogo } from "@/app/components/vera-shell/VeraSiteLogo";

const NAV_ITEMS = [
    {
        href: null,
        labelKey: "nav.assistant",
        icon: MessageSquare,
    },
    { href: "/projects", labelKey: "nav.projects", icon: FolderOpen },
    {
        href: null,
        labelKey: "nav.tabular",
        icon: Table2,
    },
    { href: null, labelKey: "nav.workflows", icon: Library },
    { href: null, labelKey: "nav.settings", icon: Settings },
] as const;

interface VeraSidebarProps {
    isOpen: boolean;
    onToggle: () => void;
}

export function VeraSidebar({ isOpen, onToggle }: VeraSidebarProps) {
    const router = useRouter();
    const pathname = usePathname();
    const { t } = useI18n();
    const [shouldAnimate, setShouldAnimate] = useState(false);

    const handleToggle = () => {
        if (isOpen) setShouldAnimate(true);
        onToggle();
    };

    return (
        <>
            {/* Mobile: tapping outside the expanded sidebar closes it. The
                sidebar (z-[99]) sits above this scrim (z-[98]); md+ is
                unaffected since the sidebar is part of the layout there. */}
            {isOpen && (
                <div
                    className="fixed inset-0 z-[98] bg-gray-300/20 md:hidden"
                    onClick={handleToggle}
                    aria-hidden="true"
                />
            )}
            <div
                id="vera-sidebar"
                className={cn(
                    isOpen
                        ? "w-64 h-[calc(100dvh-1rem)] md:h-[calc(100dvh-1.5rem)] bg-white/65"
                        : "max-md:hidden w-14 md:h-[calc(100dvh-1.5rem)] md:bg-white/65 h-auto bg-transparent pointer-events-none md:pointer-events-auto",
                    "my-2 ml-2 mr-0 md:my-3 md:ml-3 md:mr-0 rounded-2xl border border-white/70 shadow-[0_-1px_6px_rgba(15,23,42,0.034),0_4px_9px_rgba(15,23,42,0.074),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-2xl overflow-visible",
                    "flex flex-col transition-all duration-300 absolute md:relative z-[99]",
                )}
            >
                {/* Toggle + Logo */}
                <div
                    className={`items-center justify-between px-2.5 py-3 ${
                        !isOpen ? "hidden md:flex" : "flex"
                    }`}
                >
                    {isOpen && (
                        <div className="px-2">
                            <VeraSiteLogo
                                size="md"
                                animate={shouldAnimate}
                                asLink
                            />
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={handleToggle}
                        className={cn(
                            "h-9 w-9 p-2.5 items-center flex transition-colors",
                            "rounded-md hover:bg-gray-100",
                        )}
                        title={
                            isOpen
                                ? t("common.actions.close")
                                : t("common.actions.open")
                        }
                        aria-label={
                            isOpen
                                ? t("common.actions.close")
                                : t("common.actions.open")
                        }
                        aria-expanded={isOpen}
                    >
                        <PanelLeft className="h-4 w-4" />
                    </button>
                </div>

                {/* Nav items */}
                {NAV_ITEMS.map(({ href, labelKey, icon: Icon }) => {
                    // Vera local patch: only the service-backed Projects and
                    // Documents surface is interactive in this milestone.
                    // Keeping future Mike modules visible-but-disabled avoids
                    // inventing links before their local composition lands.
                    const isAvailable = href !== null;
                    const isActive =
                        isAvailable &&
                        (pathname === href || pathname.startsWith(href + "/"));
                    const label = t(labelKey);
                    return (
                        <div key={labelKey} className="py-0.5 px-2.5">
                            <button
                                type="button"
                                onClick={
                                    isAvailable
                                        ? () => router.push(href)
                                        : undefined
                                }
                                disabled={!isAvailable}
                                aria-disabled={!isAvailable || undefined}
                                title={!isOpen || !isAvailable ? label : ""}
                                aria-current={isActive ? "page" : undefined}
                                className={cn(
                                    "w-full h-9 flex items-center gap-3 px-2.5 py-2 rounded-md transition-colors text-left",
                                    isActive
                                        ? "bg-gray-200/60 text-gray-900"
                                        : isAvailable
                                          ? "text-gray-700 hover:bg-gray-100"
                                          : "cursor-not-allowed text-gray-400 opacity-60",
                                    !isOpen ? "hidden md:flex" : "flex",
                                )}
                            >
                                <Icon
                                    className={`h-4 w-4 flex-shrink-0 ${
                                        !isAvailable
                                            ? "text-gray-400"
                                            : isActive
                                            ? "text-gray-900"
                                            : "text-black"
                                    }`}
                                />
                                {isOpen && (
                                    <span
                                        className={`text-sm font-medium ${
                                            shouldAnimate
                                                ? "sidebar-fade-in-2"
                                                : ""
                                        }`}
                                    >
                                        {label}
                                    </span>
                                )}
                            </button>
                        </div>
                    );
                })}

                {/* Vera local port: retain Mike's secondary-content container
                    but hide its cloud-bound recent-project/history/profile
                    blocks until their local service-backed ports land. */}
                {isOpen && (
                    <div
                        hidden
                        aria-hidden="true"
                        className="mt-4 flex-1 min-h-0 flex flex-col gap-4"
                    />
                )}
            </div>
        </>
    );
}
