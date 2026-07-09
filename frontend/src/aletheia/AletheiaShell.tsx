"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    ClipboardCheck,
    FileSearch,
    History,
    Library,
    Menu,
    Scale,
    Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AletheiaIcon } from "@/components/chat/aletheia-icon";

const navItems = [
    { href: "/aletheia", label: "Matters", icon: Scale },
    { href: "/aletheia/templates", label: "Templates", icon: Library },
    { href: "/aletheia/evidence", label: "Evidence", icon: FileSearch },
    { href: "/aletheia/reviews", label: "Reviews", icon: ClipboardCheck },
    { href: "/aletheia/agentops", label: "Command Center", icon: Workflow },
    { href: "/aletheia/audit", label: "Audit", icon: History },
];

export function AletheiaShell({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();

    return (
        <div className="flex h-dvh bg-white text-gray-900">
            <aside className="hidden w-64 shrink-0 flex-col border-r border-gray-200 bg-gray-50 md:flex">
                <div className="mb-3 flex items-center justify-between px-5 py-4">
                    <Link
                        href="/aletheia"
                        className="flex items-center gap-2 transition-opacity hover:opacity-80"
                    >
                        <AletheiaIcon size={28} />
                        <span className="font-serif text-2xl font-light leading-none">
                            Aletheia
                        </span>
                    </Link>
                </div>

                <nav className="space-y-1 px-2.5">
                    {navItems.map((item) => {
                        const isActive =
                            pathname === item.href ||
                            (item.href !== "/aletheia" &&
                                pathname.startsWith(`${item.href}/`));
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={cn(
                                    "flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors",
                                    isActive
                                        ? "bg-gray-100 text-gray-900"
                                        : "text-gray-700 hover:bg-gray-100 hover:text-gray-900",
                                )}
                            >
                                <item.icon className="h-4 w-4 text-gray-900" />
                                {item.label}
                            </Link>
                        );
                    })}
                </nav>

                <div className="mt-auto border-t border-gray-200 px-5 py-4">
                    <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-gray-400">
                        Verifiable workspace
                    </p>
                    <p className="mt-1 text-xs leading-5 text-gray-500">
                        Matter workflows, evidence, reviews, and audit records.
                    </p>
                </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 md:hidden">
                    <Menu className="h-5 w-5 text-gray-500" />
                    <Link
                        href="/aletheia"
                        className="flex items-center gap-2 transition-opacity hover:opacity-80"
                    >
                        <AletheiaIcon size={24} />
                        <span className="font-serif text-xl font-light">Aletheia</span>
                    </Link>
                </header>
                <main className="min-h-0 flex-1 overflow-y-auto bg-white">{children}</main>
            </div>
        </div>
    );
}
