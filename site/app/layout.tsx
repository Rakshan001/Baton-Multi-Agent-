import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { SITE_URL } from "@/lib/site-url";

const grotesk = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-grotesk",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});
const REPO = "https://github.com/Rakshan001/Baton-Multi-Agent-";
const DESCRIPTION =
  "Baton coordinates multiple AI coding agents — Claude Code, Cursor, Codex, Gemini — on one repo. Isolated git worktrees, a live dashboard, shared memory, installable skills, and one-file session handoff. Open source.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Baton — coordinate AI coding agents on one repo",
  description: DESCRIPTION,
  applicationName: "Baton",
  authors: [{ name: "Rakshan Shetty" }],
  keywords: [
    "AI coding agents",
    "Claude Code",
    "Cursor",
    "Codex",
    "Gemini CLI",
    "git worktree",
    "multi-agent",
    "session handoff",
    "knowledge graph",
    "developer tools",
    "open source",
  ],
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: "website",
    url: SITE_URL,
    title: "Baton — coordinate AI coding agents on one repo",
    description: DESCRIPTION,
    siteName: "Baton",
  },
  twitter: {
    card: "summary_large_image",
    title: "Baton — coordinate AI coding agents on one repo",
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
  colorScheme: "dark",
};

// JSON-LD: SoftwareApplication schema for richer search results.
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Baton",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  description: DESCRIPTION,
  url: SITE_URL,
  downloadUrl: REPO,
  softwareVersion: "0.0.1",
  license: "https://opensource.org/licenses/MIT",
  author: { "@type": "Person", name: "Rakshan Shetty" },
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${grotesk.variable} ${mono.variable}`}>
      <body>
        <noscript>
          <style>{`.reveal{opacity:1 !important;transform:none !important}`}</style>
        </noscript>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-amber focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-black"
        >
          Skip to content
        </a>
        {children}
        <script
          type="application/ld+json"
          // JSON-LD must be raw text in a script tag.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </body>
    </html>
  );
}
