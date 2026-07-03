/* ============================================================
   BATON — demo knowledge-base fixtures
   Small deterministic graphs so the Knowledge Graph page is fully
   explorable in demo mode (search, communities, inspect, switcher).
   ============================================================ */
import type { KbStatus, GraphData, GraphNode, GraphLink, ContextPackResponse } from "../types";

export const DEMO_KB: KbStatus = {
  initialized: true,
  graphifyInstalled: true,
  projects: [
    { id: "api", name: "api", path: "~/work/orbit/api", nodes: 38, edges: 61, communities: 5, lastBuiltAt: new Date(Date.now() - 8 * 60_000).toISOString(), building: false },
    { id: "web", name: "web", path: "~/work/orbit/web", nodes: 27, edges: 41, communities: 4, lastBuiltAt: new Date(Date.now() - 8 * 60_000).toISOString(), building: false },
  ],
  merged: { id: "merged", name: "Merged", path: "~/work/orbit", nodes: 65, edges: 104, communities: 9, lastBuiltAt: new Date(Date.now() - 8 * 60_000).toISOString(), building: false },
};

function makeGraph(prefix: string, spec: Array<[string, string, number]>, rels: Array<[string, string, string]>): GraphData {
  const nodes: GraphNode[] = spec.map(([label, fileType, community]) => ({
    id: `${prefix}::${label}`,
    label,
    file_type: fileType,
    source_file: `${fileType === "code" ? "src" : "docs"}/${label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.${fileType === "code" ? "ts" : "md"}`,
    source_location: `L${10 + (label.length * 7) % 200}`,
    community,
    norm_label: label.toLowerCase(),
  }));
  const links: GraphLink[] = rels.map(([s, t, relation]) => ({
    source: `${prefix}::${s}`, target: `${prefix}::${t}`, relation, confidence: "EXTRACTED", confidence_score: 0.9,
  }));
  return { directed: true, nodes, links };
}

const API_GRAPH = makeGraph("api", [
  ["AuthService", "code", 0], ["TokenStore", "code", 0], ["LoginRoute", "code", 0], ["SessionMiddleware", "code", 0],
  ["UserRepo", "code", 1], ["UserModel", "code", 1], ["MigrationRunner", "code", 1], ["DatabasePool", "code", 1],
  ["PaymentService", "code", 2], ["StripeClient", "code", 2], ["WebhookHandler", "code", 2], ["InvoiceJob", "code", 2],
  ["RateLimiter", "code", 3], ["RedisCache", "code", 3], ["MetricsEmitter", "code", 3],
  ["API Overview", "document", 4], ["Auth Flow Doc", "document", 4],
], [
  ["LoginRoute", "AuthService", "calls"], ["AuthService", "TokenStore", "calls"], ["SessionMiddleware", "TokenStore", "calls"],
  ["AuthService", "UserRepo", "calls"], ["UserRepo", "UserModel", "references"], ["UserRepo", "DatabasePool", "calls"],
  ["MigrationRunner", "DatabasePool", "calls"], ["PaymentService", "StripeClient", "calls"], ["WebhookHandler", "PaymentService", "calls"],
  ["InvoiceJob", "PaymentService", "calls"], ["PaymentService", "UserRepo", "calls"], ["LoginRoute", "RateLimiter", "calls"],
  ["RateLimiter", "RedisCache", "calls"], ["MetricsEmitter", "RedisCache", "calls"], ["Auth Flow Doc", "AuthService", "references"],
  ["API Overview", "LoginRoute", "references"], ["API Overview", "PaymentService", "references"],
]);

const WEB_GRAPH = makeGraph("web", [
  ["App", "code", 0], ["Router", "code", 0], ["AuthContext", "code", 0],
  ["LoginPage", "code", 1], ["LoginForm", "code", 1], ["useAuth", "code", 1],
  ["Dashboard", "code", 2], ["StatsPanel", "code", 2], ["ChartCard", "code", 2], ["useApi", "code", 2],
  ["DesignTokens", "code", 3], ["Button", "code", 3], ["Modal", "code", 3],
], [
  ["App", "Router", "contains"], ["App", "AuthContext", "contains"], ["Router", "LoginPage", "references"],
  ["Router", "Dashboard", "references"], ["LoginPage", "LoginForm", "contains"], ["LoginForm", "useAuth", "calls"],
  ["useAuth", "AuthContext", "references"], ["Dashboard", "StatsPanel", "contains"], ["StatsPanel", "ChartCard", "contains"],
  ["StatsPanel", "useApi", "calls"], ["LoginForm", "Button", "references"], ["Dashboard", "Modal", "references"],
  ["Button", "DesignTokens", "references"], ["Modal", "DesignTokens", "references"],
]);

const MERGED_GRAPH: GraphData = {
  directed: true,
  nodes: [...API_GRAPH.nodes, ...WEB_GRAPH.nodes.map((n) => ({ ...n, community: (n.community ?? 0) + 5 }))],
  links: [
    ...API_GRAPH.links,
    ...WEB_GRAPH.links,
    { source: "web::useApi", target: "api::LoginRoute", relation: "calls", confidence: "INFERRED", confidence_score: 0.6 },
    { source: "web::useAuth", target: "api::AuthService", relation: "references", confidence: "INFERRED", confidence_score: 0.6 },
  ],
};

export function demoGraphFor(project: string): GraphData {
  const g = project === "api" ? API_GRAPH : project === "web" ? WEB_GRAPH : MERGED_GRAPH;
  // deep-copy: force-graph mutates nodes/links (adds x/y, resolves ids to refs)
  return JSON.parse(JSON.stringify(g)) as GraphData;
}

const DEMO_PACK_MD = `# shop — project context pack

Generated 2026-07-04 · commit demo123 · by \`baton kb context\`

> **Note for the assistant reading this:** this is a generated context pack.
> Full source code is NOT included. If you need the contents of a specific
> file, ask the user to paste it.

## How the repos relate

- **api** — \`api/\` (node · express) — REST backend for the shop.
- **web** — \`web/\` (node · react · vite) — Customer-facing storefront.

## api

### Overview

REST backend for the shop: orders, payments, inventory.

### Stack & commands

**Stack:** node · express

- \`dev\` → \`nodemon src/index.ts\`
- \`test\` → \`vitest run\`

### Folder structure

\`\`\`
src/
  routes/
    orders.ts
    payments.ts
  db/
    schema.ts
\`\`\`

### Key code symbols (most connected in the code graph)

- \`createOrder\` — src/routes/orders.ts:12 (14 connections)
- \`chargeCard\` — src/routes/payments.ts:8 (9 connections)

## Project memory (evidence-checked)

- [decision] Payments retry at most twice, then park the order.

---

_~640 tokens (approximate, chars/4). Pastes into: ChatGPT free · Grok free · DeepSeek._
`;

export const DEMO_CONTEXT_PACK: ContextPackResponse = {
  markdown: DEMO_PACK_MD,
  tokens: 640,
  redactions: 0,
  omitted: [],
  fits: [
    { id: 'chatgpt-free', label: 'ChatGPT free', limit: 8000, ok: true },
    { id: 'grok-free', label: 'Grok free', limit: 32000, ok: true },
    { id: 'deepseek', label: 'DeepSeek', limit: 128000, ok: true },
  ],
};
