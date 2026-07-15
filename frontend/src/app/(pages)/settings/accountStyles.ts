// Direct Vera port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/account/accountStyles.ts
import { cn } from "@/lib/utils";

export const accountGlassInputClassName = cn(
    "rounded-lg px-3 text-gray-900 placeholder:text-gray-400",
    "border border-gray-200 bg-gray-50 shadow-none",
    "focus-visible:border-gray-200 focus-visible:ring-2 focus-visible:ring-gray-300/45",
    "disabled:cursor-not-allowed disabled:text-gray-700 disabled:opacity-100 disabled:placeholder:text-gray-600",
    "dark:border-white/10 dark:bg-white/5 dark:text-gray-100 dark:placeholder:text-gray-500",
);

export const accountGlassSectionClassName =
    "overflow-hidden rounded-xl border border-white/70 bg-white/55 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)] backdrop-blur-2xl dark:border-white/10 dark:bg-white/5 dark:shadow-none";

export const accountGlassButtonClassName = cn(
    "rounded-lg border border-transparent bg-transparent px-3 text-gray-700 shadow-none transition-colors hover:bg-gray-100 hover:text-gray-950 active:bg-gray-200",
    "disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100",
    "dark:text-gray-300 dark:hover:bg-white/10 dark:hover:text-white dark:active:bg-white/15",
);

export const accountGlassPrimaryButtonClassName =
    "rounded-lg border border-transparent bg-transparent px-3 text-gray-900 shadow-none transition-colors hover:bg-gray-100 hover:text-gray-950 active:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-45 dark:text-gray-100 dark:hover:bg-white/10 dark:hover:text-white dark:active:bg-white/15";

export const accountGlassDangerButtonClassName =
    "rounded-lg border border-transparent bg-transparent px-3 text-red-600 shadow-none transition-colors hover:bg-red-50 hover:text-red-700 active:bg-red-100 disabled:cursor-not-allowed disabled:opacity-45 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300";

export const accountGlassIconButtonClassName =
    "justify-center rounded-lg bg-transparent px-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-gray-200";

export function accountTabButtonClassName(active: boolean) {
    return cn(
        "flex h-9 w-full items-center rounded-lg px-3 text-left text-sm font-medium whitespace-nowrap transition-colors",
        active
            ? "bg-gray-100 text-gray-900 dark:bg-white/10 dark:text-white"
            : "text-gray-500 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-100",
    );
}
