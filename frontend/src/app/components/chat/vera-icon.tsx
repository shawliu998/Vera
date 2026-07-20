"use client";

import type { CSSProperties } from "react";

export function VeraIcon({
    spin = false,
    done = false,
    error = false,
    size = 24,
    style,
}: {
    spin?: boolean;
    done?: boolean;
    error?: boolean;
    mike?: boolean;
    size?: number;
    style?: CSSProperties;
}) {
    const accent = error ? "#c2413b" : done ? "#27845b" : "#5278b8";

    return (
        <span
            aria-hidden="true"
            className="inline-block shrink-0 motion-reduce:animate-none"
            style={{
                animation: spin ? "spin 1.8s linear infinite" : undefined,
                ...style,
            }}
        >
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 64 64"
                width={size}
                height={size}
                fill="none"
                style={{ display: "block" }}
            >
                <path
                    d="M7 12h13.8l12.7 30.7c1.1 2.7 3.8 4.5 6.8 4.5h3.2l-4.6 7.3h-2.4c-7 0-13.3-4.2-16-10.7L7 12Z"
                    fill="#18202d"
                />
                <path
                    d="M57 12H43.1L31.4 40.1l2.1 5c1.1 2.7 3.8 4.5 6.8 4.5h3.1L57 12Z"
                    fill={accent}
                />
            </svg>
        </span>
    );
}
