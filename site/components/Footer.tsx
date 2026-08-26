// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { REPO_URL, DOCS_URL, LICENSE_URL } from "./site";

export default function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 px-5 py-12 sm:flex-row">
        <div>
          <p className="font-mono text-lg font-medium text-fg">
            <span className="amber-text">/</span>baton
          </p>
          <p className="mt-1 font-mono text-sm text-faint">Pass it on.</p>
        </div>

        <nav aria-label="Footer" className="flex items-center gap-6 text-sm text-muted">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-fg">
            GitHub
          </a>
          <Link href={DOCS_URL} className="transition-colors hover:text-fg">
            Docs
          </Link>
          <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-fg">
            License
          </a>
        </nav>
      </div>
      <div className="border-t border-line py-5">
        <p className="text-center font-mono text-xs text-faint">
          AGPL-3.0 © Rakshan Shetty · Built for developers running more than one agent.
        </p>
      </div>
    </footer>
  );
}
