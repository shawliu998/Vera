"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/shared/AppSidebar.tsx
import { useEffect, useMemo, useState } from "react";
import {
    PanelLeft,
    MessageSquare,
    FolderOpen,
    Table2,
    Library,
    Settings,
    ChevronDown,
    RefreshCw,
} from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { useI18n } from "@/app/i18n";
import { useVeraSettings } from "@/app/contexts/VeraSettingsContext";
import { cn } from "@/lib/utils";
import { VeraSiteLogo } from "@/app/components/vera-shell/VeraSiteLogo";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { SidebarChatItem } from "@/app/components/assistant/SidebarChatItem";

const NAV_ITEMS = [
    {
        href: "/assistant",
        labelKey: "nav.assistant",
        icon: MessageSquare,
    },
    { href: "/projects", labelKey: "nav.projects", icon: FolderOpen },
    {
        href: "/tabular-review",
        labelKey: "nav.tabular",
        icon: Table2,
    },
    { href: "/workflows", labelKey: "nav.workflows", icon: Library },
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
    const { settingsRuntimeAvailable } = useVeraSettings();
    const {
        chats,
        hasMoreChats,
        error: chatHistoryError,
        currentChatId,
        setCurrentChatId,
        loadChats,
        loadMoreChats,
    } = useChatHistoryContext();
    const [shouldAnimate, setShouldAnimate] = useState(false);
    const [historyCollapsed, setHistoryCollapsed] = useState(false);
    const routeChatId = useMemo(() => {
        const global = pathname.match(/^\/assistant\/chat\/([^/]+)/);
        const project = pathname.match(
            /^\/projects\/[^/]+\/assistant\/chat\/([^/]+)/,
        );
        return global?.[1] ?? project?.[1] ?? null;
    }, [pathname]);

    useEffect(() => {
        setCurrentChatId(routeChatId);
    }, [routeChatId, setCurrentChatId]);

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
                    // Vera local patch: Settings becomes interactive only
                    // after its canonical status endpoint explicitly reports
                    // settings_available=true. A missing or failed service
                    // therefore leaves the Mike navigation item disabled.
                    const resolvedHref =
                        labelKey === "nav.settings" &&
                        settingsRuntimeAvailable
                            ? "/settings"
                            : href;
                    const isAvailable = href !== null || resolvedHref !== null;
                    const isActive =
                        isAvailable &&
                        (pathname === resolvedHref ||
                            pathname.startsWith(resolvedHref + "/"));
                    const label = t(labelKey);
                    return (
                        <div key={labelKey} className="py-0.5 px-2.5">
                            <button
                                type="button"
                                onClick={
                                    resolvedHref !== null
                                        ? () => router.push(resolvedHref)
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

                {isOpen && (
                    <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
                        {/* Mike's Assistant History block, backed only by the
                            local Vera Chats service. */}
                        <div className="flex min-h-0 flex-1 flex-col">
                            <button
                                type="button"
                                onClick={() =>
                                    setHistoryCollapsed((current) => !current)
                                }
                                className={`mb-2 flex w-full items-center justify-between px-5 text-xs font-semibold text-gray-500 transition-colors hover:text-gray-700 ${
                                    shouldAnimate ? "sidebar-fade-in" : ""
                                }`}
                            >
                                <span>{t("assistant.history.title")}</span>
                                <ChevronDown
                                    className={`h-3.5 w-3.5 transition-transform ${
                                        historyCollapsed ? "-rotate-90" : ""
                                    }`}
                                />
                            </button>
                            {!historyCollapsed && (
                                <div className="min-h-0 flex-1 overflow-y-auto">
                                    {chats === null ? (
                                        <div className="space-y-1 px-2.5">
                                            {[40, 60, 50, 70, 45].map(
                                                (width, index) => (
                                                    <div
                                                        key={index}
                                                        className="flex h-9 items-center px-3"
                                                    >
                                                        <div
                                                            className="h-3 animate-pulse rounded bg-gray-200"
                                                            style={{
                                                                width: `${width}%`,
                                                            }}
                                                        />
                                                    </div>
                                                ),
                                            )}
                                        </div>
                                    ) : chatHistoryError ? (
                                        <button
                                            type="button"
                                            onClick={() => void loadChats()}
                                            className="mx-2.5 flex w-[calc(100%-1.25rem)] items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-red-600 hover:bg-red-50"
                                        >
                                            <RefreshCw className="h-3.5 w-3.5" />
                                            {t("assistant.history.reload")}
                                        </button>
                                    ) : chats.length === 0 ? (
                                        <p className="px-5 py-2 text-xs text-gray-500">
                                            {t("assistant.history.empty")}
                                        </p>
                                    ) : (
                                        <>
                                            <div className="space-y-1 px-2.5">
                                                {chats.map((chat) => (
                                                    <SidebarChatItem
                                                        key={chat.id}
                                                        chat={chat}
                                                        active={
                                                            currentChatId ===
                                                            chat.id
                                                        }
                                                        onSelect={() => {
                                                            setCurrentChatId(
                                                                chat.id,
                                                            );
                                                            router.push(
                                                                chat.project_id
                                                                    ? `/projects/${chat.project_id}/assistant/chat/${chat.id}`
                                                                    : `/assistant/chat/${chat.id}`,
                                                            );
                                                        }}
                                                    />
                                                ))}
                                            </div>
                                            {hasMoreChats && (
                                                <div className="px-2.5 pt-1">
                                                    <button
                                                        type="button"
                                                        onClick={loadMoreChats}
                                                        className="flex h-8 w-full items-center rounded-md px-3 text-left text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                                                    >
                                                        {t("assistant.history.loadMore")}
                                                    </button>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
