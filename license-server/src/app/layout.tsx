import type { Metadata } from "next";
import { IBM_Plex_Sans_Thai, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const thai = IBM_Plex_Sans_Thai({ weight: ["400", "500", "600", "700"], subsets: ["thai", "latin"], variable: "--font-thai", display: "swap" });
const code = JetBrains_Mono({ weight: ["400", "500"], subsets: ["latin"], variable: "--font-code", display: "swap" });

export const metadata: Metadata = { title: "License Admin — AI Affiliate Studio", robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="th" className={`${thai.variable} ${code.variable}`}><body><main className="mx-auto max-w-7xl px-4 pb-16 pt-5 sm:px-6 md:pt-8">{children}</main></body></html>;
}
