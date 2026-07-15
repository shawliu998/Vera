"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/site-logo.tsx
import Link from "next/link";
import { VeraMark } from "@/app/components/vera-brand";
import { useI18n } from "@/app/i18n";

export interface VeraSiteLogoProps {
    size?: "sm" | "md" | "lg" | "xl";
    className?: string;
    iconClassName?: string;
    animate?: boolean;
    asLink?: boolean;
}

export function VeraSiteLogo({
    size = "md",
    className = "",
    iconClassName = "",
    animate = false,
    asLink = false,
}: VeraSiteLogoProps) {
    const { t } = useI18n();
    // Vera local patch: the desktop brand always returns to the local product.
    const landingHref = "/assistant";
    const sizeClasses = {
        sm: "text-xl",
        md: "text-2xl",
        lg: "text-4xl",
        xl: "text-6xl",
    };

    const iconSizes = {
        sm: 20,
        md: 22,
        lg: 30,
        xl: 48,
    };

    const logo = (
        <h1
            className={`flex items-center gap-1.5 ${sizeClasses[size]} font-light font-serif ${
                animate ? "sidebar-fade-in" : ""
            } ${className}`}
        >
            <span
                className={`inline-flex shrink-0 items-center leading-none ${iconClassName}`}
            >
                <VeraMark size={iconSizes[size]} decorative />
            </span>
            <span>{t("common.appName")}</span>
        </h1>
    );

    if (asLink) {
        return (
            <Link
                href={landingHref}
                aria-label={t("common.appName")}
                className="cursor-pointer hover:opacity-80 transition-opacity"
            >
                {logo}
            </Link>
        );
    }

    return logo;
}
