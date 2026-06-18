import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This site lives inside the Baton monorepo, which has its own lockfile at the
  // repo root. Pin the tracing root to this folder so Next stops warning about
  // the multiple lockfiles it detects above us.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
