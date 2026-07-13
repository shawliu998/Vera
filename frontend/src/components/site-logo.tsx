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
        sm: "text-[18px]",
        md: "text-[22px]",
        lg: "text-[34px]",
        xl: "text-[52px]",
    };

    const iconSizes = {
        sm: 24,
        md: 28,
        lg: 40,
        xl: 56,
    };

    const logo = (
        <h1
            className={`flex items-center gap-2 ${sizeClasses[size]} font-sans ${
                animate ? "sidebar-fade-in" : ""
            } ${className}`}
        >
            <AletheiaIcon size={iconSizes[size]} />
            <span className="font-semibold leading-none">Vera</span>
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
