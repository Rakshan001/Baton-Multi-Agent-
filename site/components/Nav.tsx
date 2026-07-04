import Link from "next/link";
import CopyChip from "./CopyChip";
import NavShell from "./NavShell";
import MobileMenu from "./MobileMenu";
import { NAV_LINKS, REPO_URL, CLONE_CMD } from "./site";

// Fetch the live star count at build time. Falls back gracefully if the
// GitHub API is unreachable or rate-limited (no token needed for a build).
async function getStars(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/Rakshan001/Baton-Multi-Agent-",
      {
        headers: { Accept: "application/vnd.github+json" },
        next: { revalidate: 3600 },
      },
    );
    if (!res.ok) return null;
    const data: { stargazers_count?: number } = await res.json();
    return typeof data.stargazers_count === "number"
      ? data.stargazers_count
      : null;
  } catch {
    return null;
  }
}

export default async function Nav() {
  const stars = await getStars();

  return (
    <NavShell>
      <nav
        aria-label="Primary"
        className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-5 py-3"
      >
        <Link
          href="#top"
          className="font-mono text-lg font-medium tracking-tight text-fg"
          aria-label="Baton home"
        >
          <span className="amber-text">/</span>baton
        </Link>

        <ul className="hidden items-center gap-7 text-sm text-muted md:flex">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target={"external" in link && link.external ? "_blank" : undefined}
                rel={
                  "external" in link && link.external
                    ? "noopener noreferrer"
                    : undefined
                }
                className="transition-colors hover:text-fg"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-3">
          <div className="hidden lg:block">
            <CopyChip command={CLONE_CMD} prefix="$" />
          </div>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-full border border-line-strong bg-amber/10 px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-amber/20"
          >
            <GitHubGlyph />
            <span>Star</span>
            {stars !== null && stars > 0 && (
              <span
                className="font-mono text-amber"
                aria-label={`${stars} GitHub stars`}
              >
                {formatStars(stars)}
              </span>
            )}
          </a>
          <MobileMenu />
        </div>
      </nav>
    </NavShell>
  );
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function GitHubGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.13-.31-.54-1.53.12-3.19 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.19.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.65-5.49 5.95.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" />
    </svg>
  );
}
