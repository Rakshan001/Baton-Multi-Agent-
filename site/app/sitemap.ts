// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MetadataRoute } from "next";
import { DOCS_ORDER } from "@/components/docs-nav";
import { SITE_URL } from "@/lib/site-url";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    {
      url: SITE_URL,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    // Driven by the docs nav, so a new page is never missing from the sitemap.
    ...DOCS_ORDER.map((page) => ({
      url: `${SITE_URL}${page.href}`,
      lastModified,
      changeFrequency: "monthly" as const,
      priority: page.href === "/docs" ? 0.8 : 0.6,
    })),
  ];
}
