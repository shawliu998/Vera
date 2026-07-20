import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "@/app/components/providers";

const inter = localFont({
    src: "./assets/fonts/inter-latin.woff2",
    variable: "--font-inter",
    display: "swap",
    weight: "100 900",
});

const ebGaramond = localFont({
    src: "./assets/fonts/eb-garamond-latin.woff2",
    variable: "--font-eb-garamond",
    display: "swap",
    weight: "400 700",
});

export const metadata: Metadata = {
    metadataBase: new URL("https://vera.local"),
    title: "Vera - Legal Workspace",
    description:
        "AI-powered legal document analysis and contract review platform.",
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
    openGraph: {
        type: "website",
        url: "https://vera.local",
        siteName: "Vera",
        title: "Vera - Legal Workspace",
        description:
            "AI-powered legal document analysis and contract review platform.",
        images: [
            {
                url: "/link-image.jpg",
                width: 1200,
                height: 651,
                alt: "Vera",
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: "Vera - Legal Workspace",
        description:
            "AI-powered legal document analysis and contract review platform.",
        images: ["/link-image.jpg"],
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                className={`${inter.variable} ${ebGaramond.variable} font-sans antialiased`}
            >
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
