import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import type { Metadata } from "next";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

const isLocalDev = process.env.NODE_ENV === "development" && !process.env.VERCEL_ENV;

export const metadata: Metadata = {
  title: isLocalDev ? "opencompany (local)" : "opencompany",
  description: "Company workspace for agents, inbox, and shared context.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/brand/opencompany-icon-dark.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="system" suppressHydrationWarning>
      <head>
        <script
          // Apply the stored theme before React hydrates so manual dark/light
          // selections do not flash back to the system preference on reload.
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
      </head>
      <body className="font-sans antialiased text-[14px] text-ink">
        <ThemeProvider initialTheme="system">
          <AuthKitProvider>{children}</AuthKitProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

const themeInitScript = `(()=>{try{var e="opencompany-theme",t={system:1,light:1,dark:1},m=localStorage.getItem(e);if(!t[m]){var r=document.cookie.match(/(?:^|; )opencompany-theme=([^;]*)/);m=r?decodeURIComponent(r[1]):"system"}if(!t[m])m="system";var o=m==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;document.documentElement.dataset.theme=m;document.documentElement.dataset.resolvedTheme=o}catch(e){}})();`;
