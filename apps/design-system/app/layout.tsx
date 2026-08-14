import { Toaster } from "@opencompany/ui/components/sonner";
import { TooltipProvider } from "@opencompany/ui/components/tooltip";
import type { Metadata } from "next";
import type * as React from "react";
import { DocsShell } from "@/components/docs-shell";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "opencompany Design System",
  description: "Components, tokens, and foundations for the opencompany product.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider>
          <TooltipProvider>
            <DocsShell>{children}</DocsShell>
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
