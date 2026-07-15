import type { Metadata } from "next";
import "./globals.css";

// Desktop CSP nonces are generated per request by src/proxy.ts. Next can only
// attach those nonces to framework and hydration scripts during dynamic render.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL("https://vera.local"),
  title: "Vera",
  description: "Vera 本地法律工作空间。",
  icons: {
    icon: [{ url: "/vera-mark.png", type: "image/png" }],
    apple: "/vera-mark.png",
  },
  openGraph: {
    type: "website",
    url: "https://vera.local",
    siteName: "Vera",
    title: "Vera",
    description: "Vera 本地法律工作空间。",
    images: [{ url: "/vera-mark.png", width: 208, height: 208, alt: "Vera" }],
  },
  twitter: {
    card: "summary",
    title: "Vera",
    description: "Vera 本地法律工作空间。",
    images: ["/vera-mark.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
