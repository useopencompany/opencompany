import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import type { Metadata } from "next";
import "./globals.css";

const isLocalDev = process.env.NODE_ENV === "development" && !process.env.VERCEL_ENV;

export const metadata: Metadata = {
  title: isLocalDev ? "opencompany (local)" : "opencompany",
  description: "Company workspace for agents, inbox, and shared context.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased text-[14px] text-ink">
        <AuthKitProvider>{children}</AuthKitProvider>
      </body>
    </html>
  );
}
