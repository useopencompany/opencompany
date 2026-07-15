import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";
import type * as React from "react";
import "./globals.css";

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "OpenCompany — Give your company a brain",
  description:
    "Point it at your GitHub, Gmail, Linear, Slack, and meetings. It figures out what matters, files it, and links it to what you already know — so every model you talk to actually knows your company.",
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
    <html lang="en" data-theme="light" className={geistMono.variable}>
      <body className="min-h-dvh bg-canvas font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
