import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://vera.local"),
  title: "Vera",
  description: "Local legal workspace.",
  icons: {
    icon: [
      { url: "/icon.png", type: "image/png", sizes: "1024x1024" },
      { url: "/favicon.ico" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    url: "https://vera.local",
    siteName: "Vera",
    title: "Vera",
    description: "Local legal workspace.",
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
    title: "Vera",
    description: "Local legal workspace.",
    images: ["/link-image.jpg"],
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
