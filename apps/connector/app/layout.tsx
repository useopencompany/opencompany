import type { Metadata } from "next";
import type * as React from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Connector",
  description: "A focused MVP experiment for runconnector.com.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
