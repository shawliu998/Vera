"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/layout.tsx
import { useCallback, useState, useEffect } from "react";
import { PanelLeft } from "lucide-react";
import { SidebarContext } from "@/app/contexts/SidebarContext";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";
import {
    I18nProvider,
    useI18n,
    type SupportedLocale,
} from "@/app/i18n";
import { VeraSettingsProvider } from "@/app/contexts/VeraSettingsContext";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";
import { VeraSidebar } from "@/app/components/vera-shell/VeraSidebar";

const SIDEBAR_STORAGE_KEY = "veraSidebarOpen";

export interface VeraShellProps {
    children: React.ReactNode;
    initialLocale?: SupportedLocale;
}

function VeraShellLayout({ children }: { children: React.ReactNode }) {
    const { t } = useI18n();
    const [mobileActionsContainer, setMobileActionsContainer] =
        useState<HTMLDivElement | null>(null);

    const [isSidebarOpenDesktop, setIsSidebarOpenDesktop] = useState(() => {
        if (typeof window !== "undefined") {
            const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY);
            return saved !== null ? saved === "true" : true;
        }
        return true;
    });

    const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
        if (typeof window !== "undefined" && window.innerWidth < 768) {
            return false;
        }
        return true;
    });

    useEffect(() => {
        if (typeof window !== "undefined" && window.innerWidth >= 768) {
            localStorage.setItem(
                SIDEBAR_STORAGE_KEY,
                isSidebarOpenDesktop.toString(),
            );
        }
    }, [isSidebarOpenDesktop]);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const handleResize = () => {
            const isSmall = window.innerWidth < 768;
            if (isSmall && isSidebarOpen) setIsSidebarOpen(false);
            else if (!isSmall && !isSidebarOpen)
                setIsSidebarOpen(isSidebarOpenDesktop);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, [isSidebarOpen, isSidebarOpenDesktop]);

    const handleSidebarToggle = () => {
        if (window.innerWidth >= 768) {
            setIsSidebarOpenDesktop(!isSidebarOpenDesktop);
            setIsSidebarOpen(!isSidebarOpenDesktop);
        } else {
            setIsSidebarOpen(!isSidebarOpen);
        }
    };

    const handleMobileActionsContainerRef = useCallback(
        (node: HTMLDivElement | null) => {
            setMobileActionsContainer(node);
        },
        [],
    );

    // Vera local patch: Mike had no keyboard close path for its mobile drawer.
    useEffect(() => {
        if (!isSidebarOpen || window.innerWidth >= 768) return;
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setIsSidebarOpen(false);
        };
        document.addEventListener("keydown", handleEscape);
        return () => document.removeEventListener("keydown", handleEscape);
    }, [isSidebarOpen]);

    return (
        <PageChromeContext.Provider value={{ mobileActionsContainer }}>
            <SidebarContext.Provider
                value={{
                    setSidebarOpen: (open) => {
                        const isSmall =
                            typeof window !== "undefined" &&
                            window.innerWidth < 768;
                        if (isSmall) {
                            if (!open) setIsSidebarOpen(false);
                            return;
                        }
                        setIsSidebarOpen(open);
                        setIsSidebarOpenDesktop(open);
                    },
                }}
            >
                <div className="h-dvh flex flex-col bg-gray-50/80">
                    <div className="flex-1 flex min-w-0 overflow-visible">
                        <VeraSidebar
                            isOpen={isSidebarOpen}
                            onToggle={handleSidebarToggle}
                        />
                        <div className="flex-1 flex flex-col h-dvh md:overflow-hidden relative w-full">
                            {/* Mobile header */}
                            <div className="relative z-20 flex md:hidden items-center gap-3 overflow-visible px-4 pt-3 pb-2 shrink-0">
                                <button
                                    type="button"
                                    onClick={handleSidebarToggle}
                                    className="flex h-9 w-9 items-center justify-center rounded-full bg-white/70 text-gray-700 shadow-[0_8px_24px_rgba(15,23,42,0.12)] ring-1 ring-white/70 backdrop-blur-md transition-all hover:bg-white/90 active:scale-95"
                                    title={t("common.actions.open")}
                                    aria-label={t("common.actions.open")}
                                    aria-controls="vera-sidebar"
                                    aria-expanded={isSidebarOpen}
                                >
                                    <PanelLeft className="h-4 w-4" />
                                </button>
                                <div
                                    ref={handleMobileActionsContainerRef}
                                    className="ml-auto flex min-w-0 flex-1 items-center justify-end"
                                />
                            </div>
                            <main className="flex h-full w-full flex-1 flex-col overflow-y-auto md:overflow-hidden">
                                {children}
                            </main>
                        </div>
                    </div>
                </div>
            </SidebarContext.Provider>
        </PageChromeContext.Provider>
    );
}

export function VeraShell({ children, initialLocale }: VeraShellProps) {
    return (
        <I18nProvider initialLocale={initialLocale}>
            <VeraSettingsProvider>
                <ChatHistoryProvider>
                    <VeraShellLayout>{children}</VeraShellLayout>
                </ChatHistoryProvider>
            </VeraSettingsProvider>
        </I18nProvider>
    );
}
