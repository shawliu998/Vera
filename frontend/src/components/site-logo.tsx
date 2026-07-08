import Link from "next/link";
import { AletheiaIcon } from "@/components/chat/aletheia-icon";

interface SiteLogoProps {
    size?: "sm" | "md" | "lg" | "xl";
    className?: string;
    animate?: boolean;
    asLink?: boolean;
}

export function SiteLogo({
    size = "md",
    className = "",
    animate = false,
    asLink = false,
}: SiteLogoProps) {
    const landingHref =
        process.env.NODE_ENV === "production"
            ? "/aletheia"
            : "/aletheia";
    const sizeClasses = {
        sm: "text-xl",
        md: "text-2xl",
        lg: "text-4xl",
        xl: "text-6xl",
    };

    const iconSizes = {
        sm: 24,
        md: 28,
        lg: 40,
        xl: 56,
    };

    const logo = (
        <h1
            className={`flex items-center gap-2 ${sizeClasses[size]} font-light font-serif ${
                animate ? "sidebar-fade-in" : ""
            } ${className}`}
        >
            <AletheiaIcon size={iconSizes[size]} />
            <span>Aletheia</span>
            <span className="ml-1 text-[0.55em] font-sans font-medium text-[#6b7280]">
                明证
            </span>
        </h1>
    );

    if (asLink) {
        return (
            <Link
                href={landingHref}
                className="cursor-pointer hover:opacity-80 transition-opacity"
            >
                {logo}
            </Link>
        );
    }

    return logo;
}
