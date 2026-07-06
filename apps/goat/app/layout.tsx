import { Toaster } from "@opencompany/ui/components/sonner";
import { TooltipProvider } from "@opencompany/ui/components/tooltip";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import type { Metadata, Viewport } from "next";
import type * as React from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Goat",
  description: "Experimental just-in-time agent harness.",
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
    <html lang="en" suppressHydrationWarning>
      <body className="h-dvh overflow-hidden bg-canvas font-sans text-ink antialiased">
        <AuthKitProvider>
          <TooltipProvider>
            {children}
            <Toaster />
          </TooltipProvider>
        </AuthKitProvider>
      </body>
    </html>
  );
}
