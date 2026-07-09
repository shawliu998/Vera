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
    void brand;

    return (
        <span
            className="inline-flex shrink-0 items-center justify-center"
            style={{
                width: size,
                height: size,
                ...style,
            }}
            aria-hidden="true"
        >
            <Image
                src="/aletheia-mark.png"
                alt=""
                width={size}
                height={size}
                unoptimized
                className={spin ? "animate-[spin_3s_linear_infinite]" : ""}
                style={{
                    display: "block",
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                }}
            />
        </span>
    );
}
