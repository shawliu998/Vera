"use client";

// Direct Vera port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/account/layout.tsx
import { usePathname, useRouter } from "next/navigation";
import { useI18n, type MessageKey } from "@/app/i18n";
import { accountTabButtonClassName } from "./accountStyles";

interface TabDef {
    id: string;
    labelKey: MessageKey;
    href: string;
}

const TABS: TabDef[] = [
    {
        id: "general",
        labelKey: "settings.tabs.general",
        href: "/settings",
    },
    {
        id: "models",
        labelKey: "settings.tabs.models",
        href: "/settings/models",
    },
    {
        id: "data",
        labelKey: "settings.tabs.data",
        href: "/settings/data",
    },
];

export default function SettingsLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const { t } = useI18n();

    return (
        <div className="vera-settings-shell flex h-full flex-col overflow-y-auto">
            <header className="mx-auto flex h-16 w-full max-w-5xl shrink-0 items-end px-6 pb-2 md:h-24 md:pb-4">
                <h1 className="font-eb-garamond text-4xl font-medium">
                    {t("settings.title")}
                </h1>
            </header>

            <main className="mx-auto w-full max-w-5xl flex-1 px-6 pb-10 pt-4 md:pt-6">
                <div className="grid grid-cols-1 gap-y-6 md:grid-cols-[224px_minmax(0,1fr)] md:gap-x-10">
                    <nav
                        aria-label={t("settings.title")}
                        className="z-10 -ml-3 min-w-0 self-start md:sticky md:top-4"
                    >
                        <div className="-m-1 min-w-0 p-1">
                            <div className="-m-1 min-w-0 overflow-x-auto overflow-y-hidden p-1">
                                <ul className="mb-0 flex gap-1 md:flex-col">
                                    {TABS.map((tab) => {
                                        const active =
                                            pathname === tab.href ||
                                            (tab.href !== "/settings" &&
                                                pathname.startsWith(tab.href));
                                        return (
                                            <li key={tab.id}>
                                                <button
                                                    type="button"
                                                    aria-current={
                                                        active
                                                            ? "page"
                                                            : undefined
                                                    }
                                                    onClick={() =>
                                                        router.push(tab.href)
                                                    }
                                                    className={accountTabButtonClassName(
                                                        active,
                                                    )}
                                                >
                                                    {t(tab.labelKey)}
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        </div>
                    </nav>

                    <div className="min-w-0 outline-none">{children}</div>
                </div>
            </main>
        </div>
    );
}
