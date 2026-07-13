"use client";

import Image from "next/image";
import type { CSSProperties } from "react";

export function AletheiaIcon({
    spin = false,
    done = false,
    error = false,
    brand = false,
    size = 24,
    style,
}: {
    spin?: boolean;
    done?: boolean;
    error?: boolean;
    brand?: boolean;
    size?: number;
    style?: CSSProperties;
}) {
    void done;
    void error;
    const isWordmark = brand;
    const width = isWordmark ? Math.round(size * 3.5) : size;

    return (
        <span
            className="inline-flex shrink-0 items-center justify-center"
            style={{
                width,
                height: size,
                ...style,
            }}
            role={isWordmark ? "img" : undefined}
            aria-label={isWordmark ? "Vera" : undefined}
            aria-hidden={isWordmark ? undefined : "true"}
        >
            <Image
                src={isWordmark ? "/vera-wordmark.png" : "/vera-mark.png"}
                alt=""
                width={width}
                height={size}
                unoptimized
                className={spin ? "animate-[spin_3s_linear_infinite]" : ""}
                style={{
                    display: "block",
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    borderRadius: isWordmark ? 0 : Math.max(2, size * 0.14),
                }}
            />
        </span>
    );
}
