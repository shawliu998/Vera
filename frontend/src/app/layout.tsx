import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
    metadataBase: new URL("https://aletheia.local"),
    title: "Aletheia 明证 - Agent Workspace",
    description:
        "Agent workspace for verifiable, reviewable, and auditable professional work.",
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
    openGraph: {
        type: "website",
        url: "https://aletheia.local",
        siteName: "Aletheia 明证",
        title: "Aletheia 明证 - Agent Workspace",
        description:
            "Agent workspace for verifiable, reviewable, and auditable professional work.",
        images: [
            {
                url: "/link-image.jpg",
                width: 1200,
                height: 651,
                alt: "Aletheia 明证",
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: "Aletheia 明证 - Agent Workspace",
        description:
            "Agent workspace for verifiable, reviewable, and auditable professional work.",
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
            <body className="font-sans antialiased">
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
