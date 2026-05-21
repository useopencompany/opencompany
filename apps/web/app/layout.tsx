import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cursor",
  description: "Cursor agents dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased text-[13px] text-ink">
        {children}
      </body>
    </html>
  );
}
