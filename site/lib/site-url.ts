// Single source of truth for the site's public origin.
// Precedence: explicit NEXT_PUBLIC_SITE_URL → Vercel's production URL →
// Vercel's per-deployment URL → local dev. Vercel injects its URLs without
// a protocol, so normalize adds https:// and strips trailing slashes.
function normalize(url: string): string {
  const withProtocol = /^https?:\/\//.test(url) ? url : `https://${url}`;
  return withProtocol.replace(/\/+$/, "");
}

const fromEnv =
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.VERCEL_PROJECT_PRODUCTION_URL ||
  process.env.VERCEL_URL;

export const SITE_URL = fromEnv ? normalize(fromEnv) : "http://localhost:3000";
