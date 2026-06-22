import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

const isLocalDev = process.env.NODE_ENV === "development" && !process.env.VERCEL_ENV;

export const metadata: Metadata = {
  title: isLocalDev ? "opencompany (local)" : "opencompany",
  description: "Company workspace for agents, inbox, and shared context.",
  appleWebApp: {
    capable: true,
    title: "OpenCompany",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#111111" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="system" suppressHydrationWarning>
      <body className="font-sans antialiased text-[14px] text-ink">
        <ThemeProvider initialTheme="system">
          <AuthKitProvider>{children}</AuthKitProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
