import { Toaster } from "@opencompany/ui/components/sonner";
import { TooltipProvider } from "@opencompany/ui/components/tooltip";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import type { Metadata, Viewport } from "next";
import type * as React from "react";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenCompany",
  description: "Experimental just-in-time agent harness.",
  icons: {
    icon: [
      {
        url: "/icon/oc-icon-v3.svg",
        type: "image/svg+xml",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/icon/oc-icon-v3_white.svg",
        type: "image/svg+xml",
        media: "(prefers-color-scheme: dark)",
      },
    ],
    shortcut: [{ url: "/icon/oc-icon-v3.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#10120f" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="system" suppressHydrationWarning>
      <body className="h-dvh overflow-hidden bg-canvas font-sans text-ink antialiased">
        <ThemeProvider initialTheme="system">
          <AuthKitProvider>
            <TooltipProvider>
              {children}
              <Toaster />
            </TooltipProvider>
          </AuthKitProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
