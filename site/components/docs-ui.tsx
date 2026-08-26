// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
// Presentational primitives shared by every docs page. Keeping them here means
// a page file is almost entirely content — the prose rhythm is defined once.

import Link from "next/link";
import { docsNeighbors } from "./docs-nav";

/** Page header: mono eyebrow, title, lede. */
export function DocHeader({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede: React.ReactNode;
}) {
  return (
    <header className="mb-12">
      <p className="eyebrow mb-4">{eyebrow}</p>
      <h1 className="text-display text-balance text-4xl sm:text-5xl">{title}</h1>
      <p className="mt-5 text-pretty text-lg leading-relaxed text-muted">{lede}</p>
    </header>
  );
}

/**
 * A titled section. The `id` is what the "On this page" rail scrapes and links
 * to, so every H2 on a docs page must go through here.
 */
export function DocSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-14 scroll-mt-28">
      <h2
        id={id}
        // The rail reads this rather than textContent, which would swallow the
        // trailing "#" anchor glyph into every entry.
        data-toc-title={title}
        className="group scroll-mt-28 text-display text-2xl sm:text-[1.75rem]"
      >
        <a href={`#${id}`} className="no-underline">
          {title}
          <span
            aria-hidden="true"
            className="ml-2 text-amber opacity-0 transition-opacity group-hover:opacity-100"
          >
            #
          </span>
        </a>
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 text-pretty leading-relaxed text-muted">{children}</p>
  );
}

export function UL({ children }: { children: React.ReactNode }) {
  return <ul className="mt-4 space-y-2.5">{children}</ul>;
}

export function LI({ children }: { children: React.ReactNode }) {
  return (
    <li className="relative pl-5 leading-relaxed text-muted before:absolute before:left-0 before:top-[0.65em] before:h-1.5 before:w-1.5 before:rounded-full before:bg-amber/70">
      {children}
    </li>
  );
}

/** Inline mono token — commands, paths, flags. */
export function C({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded border border-line bg-fg/[0.04] px-1.5 py-0.5 font-mono text-[0.85em] text-fg">
      {children}
    </code>
  );
}

/** An aside with a mono label — the "// stale-brief guard" motif. */
export function Callout({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <aside className="panel mt-6 border-l-2 border-l-amber p-5">
      <p className="eyebrow mb-2">{`// ${label}`}</p>
      <div className="text-pretty leading-relaxed text-muted">{children}</div>
    </aside>
  );
}

/**
 * Two-column reference table. Wrapped in its own scroll container so a wide
 * command row never drags the whole page sideways on mobile.
 */
export function DocTable({
  head,
  rows,
}: {
  head: [string, string];
  rows: readonly (readonly [React.ReactNode, React.ReactNode])[];
}) {
  return (
    <div className="panel mt-6 overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="px-4 py-3 eyebrow font-normal">
              {head[0]}
            </th>
            <th scope="col" className="px-4 py-3 eyebrow font-normal">
              {head[1]}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              <td className="whitespace-nowrap px-4 py-3 align-top font-mono text-[0.82rem] text-fg">
                {row[0]}
              </td>
              <td className="px-4 py-3 align-top leading-relaxed text-muted">
                {row[1]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Previous/next footer, derived from the single nav order in docs-nav.ts. */
export function DocPager({ href }: { href: string }) {
  const { prev, next } = docsNeighbors(href);
  if (!prev && !next) return null;

  return (
    <nav
      aria-label="Docs pagination"
      className="mt-16 flex flex-col gap-3 border-t border-line pt-8 sm:flex-row sm:justify-between"
    >
      {prev ? (
        <Link
          href={prev.href}
          className="panel group px-5 py-4 transition-colors hover:border-line-strong sm:max-w-[48%]"
        >
          <span className="eyebrow">← previous</span>
          <span className="mt-1 block text-fg transition-colors group-hover:text-amber">
            {prev.label}
          </span>
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      {next && (
        <Link
          href={next.href}
          className="panel group px-5 py-4 text-right transition-colors hover:border-line-strong sm:max-w-[48%]"
        >
          <span className="eyebrow">next →</span>
          <span className="mt-1 block text-fg transition-colors group-hover:text-amber">
            {next.label}
          </span>
        </Link>
      )}
    </nav>
  );
}
