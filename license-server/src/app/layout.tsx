import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "License Admin — AI Affiliate Studio", robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="th"><body><main className="mx-auto max-w-6xl p-5 md:p-8">{children}</main></body></html>;
}
