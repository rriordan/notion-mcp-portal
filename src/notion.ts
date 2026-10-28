/**
 * Shared pieces:
 *  - Env bindings
 *  - Cloudflare Access JWT verification (fail closed)
 *  - Authenticated Notion API request (token never leaves this Worker)
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import spec from "./notion-openapi.json";

export { spec };

export interface Env {
  /** Notion internal integration token (secret: `wrangler secret put NOTION_TOKEN`). */
  NOTION_TOKEN: string;
  /** e.g. "your-team.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access app protecting this Worker. */
  ACCESS_AUD: string;
}

export interface NotionRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
  rawBody?: boolean;
}

const NOTION_ORIGIN = "https://api.notion.com";
const DEFAULT_NOTION_VERSION = "2025-09-03";
const MAX_RETRIES = 2;

// ---------------------------------------------------------------------------
// Notion-Version per operation (some endpoints, e.g. /markdown, need a newer one)
// ---------------------------------------------------------------------------
export type Spec = {
  paths: Record<string, Record<string, Record<string, unknown> & { parameters?: unknown[] }>>;
  components?: {
    parameters?: Record<string, { name?: string; schema?: { default?: string } }>;
    schemas?: Record<string, unknown>;
  };
};

const versionRoutes: { method: string; re: RegExp; version: string }[] = (() => {
  const s = spec as unknown as Spec;
  const routes: { method: string; re: RegExp; version: string }[] = [];
  for (const [path, ops] of Object.entries(s.paths)) {
    const re = new RegExp("^" + path.replace(/\{[^}]+\}/g, "[^/]+") + "$");
    for (const [method, op] of Object.entries(ops)) {
      let version = DEFAULT_NOTION_VERSION;
      for (const p of op?.parameters ?? []) {
        const param = p as { $ref?: string; name?: string; schema?: { default?: string } };
        const resolved = param.$ref
          ? s.components?.parameters?.[param.$ref.split("/").pop() ?? ""]
          : param;
        if (resolved?.name === "Notion-Version" && resolved.schema?.default) {
          version = resolved.schema.default;
        }
      }
      routes.push({ method: method.toUpperCase(), re, version });
    }
  }
  return routes;
})();

function notionVersionFor(method: string, path: string): string {
  return (
    versionRoutes.find((r) => r.method === method && r.re.test(path))?.version ??
    DEFAULT_NOTION_VERSION
  );
}

// ---------------------------------------------------------------------------
// Cloudflare Access JWT check
// ---------------------------------------------------------------------------
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Returns the caller's email/sub if the Access JWT is valid, otherwise null. */
export async function verifyAccess(request: Request, env: Env): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null; // fail closed
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD });
    return (payload.email as string | undefined) ?? (payload.sub as string | undefined) ?? "unknown";
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Authenticated Notion request (runs on the host, never in a sandbox)
// ---------------------------------------------------------------------------
export async function notionRequest(env: Env, opts: NotionRequest): Promise<unknown> {
  if (!opts.path.startsWith("/v1/")) {
    throw new Error(`Path must start with /v1/ (got "${opts.path}")`);
  }
  const url = new URL(opts.path, NOTION_ORIGIN);
  if (url.origin !== NOTION_ORIGIN) throw new Error("Requests may only go to api.notion.com");
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": notionVersionFor(opts.method, url.pathname),
  };
  let body: BodyInit | undefined;
  if (opts.body !== undefined && opts.method !== "GET") {
    headers["Content-Type"] = opts.contentType ?? "application/json";
    body = opts.rawBody ? (opts.body as BodyInit) : JSON.stringify(opts.body);
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: opts.method, headers, body });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const wait = Math.min(Number(res.headers.get("Retry-After") ?? "1"), 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      // Surface Notion's error (code + message) so the model can self-correct.
      const err = data as { code?: string; message?: string };
      throw new Error(`Notion API ${res.status} ${err?.code ?? ""}: ${err?.message ?? text}`.trim());
    }
    return data;
  }
}

export const NOTION_NOTES = `
Notion API notes:
- Paths start with /v1/ (e.g. /v1/search, /v1/pages/{id}). The Notion-Version header is set automatically.
- Databases are containers for data sources. Query rows with POST /v1/data_sources/{data_source_id}/query
  (get data source ids from GET /v1/databases/{database_id} -> data_sources[]).
- For readable page content prefer GET /v1/pages/{id}/markdown; edit it with PATCH /v1/pages/{id}/markdown.
- List endpoints paginate: pass start_cursor from next_cursor while has_more is true (page_size max 100).
- Only pages/databases shared with the Notion integration are visible.`;

/** Request gate. Returns a Response to short-circuit, or null to continue. */
export async function gate(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return new Response("ok");
  const user = await verifyAccess(request, env);
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!env.NOTION_TOKEN) return new Response("NOTION_TOKEN secret is not set", { status: 500 });
  return null;
}
