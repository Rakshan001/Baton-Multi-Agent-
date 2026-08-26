// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import DocsSidebar from "@/components/DocsSidebar";
import DocsToc from "@/components/DocsToc";

export const metadata: Metadata = {
  title: {
    default: "Docs — Baton",
    // Pages set their own title; this keeps the suffix consistent.
    template: "%s — Baton docs",
  },
};

export default function DocsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <Nav />
      <div className="mx-auto max-w-7xl px-5 pt-28 pb-16">
        {/* Three columns on xl (nav · content · on-this-page), two on lg,
            stacked below that with the nav collapsed into a disclosure. */}
        <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12 xl:grid-cols-[15rem_minmax(0,1fr)_13rem]">
          <DocsSidebar />

          <main id="main" className="min-w-0">
            <div id="doc-content">{children}</div>
          </main>

          <div className="hidden xl:block">
            <DocsToc />
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
}
