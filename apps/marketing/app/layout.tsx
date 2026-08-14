import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type * as React from "react";
import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  weight: ["400", "500", "600"],
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.opencompany.cloud"),
  icons: {
    icon: [{ url: "/icon/oc-icon-v3.svg", type: "image/svg+xml" }],
    shortcut: [{ url: "/icon/oc-icon-v3.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f7f7f5",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Light theme only: pinning data-theme="light" disables the shared CSS's
  // prefers-color-scheme dark fallback.
  return (
    <html lang="en" data-theme="light" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-dvh bg-canvas font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
