/**
 * Shared pieces:
 *  - Env bindings
 *  - Cloudflare Access JWT verification (fail closed)
 *  - Authenticated Notion API request (token never leaves this Worker)
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import spec from "./notion-openapi.json" with { type: "json" };
import { betaHeader, betaHint } from "./beta.ts";
import { errorTag, fetchWithRetry } from "./retry.ts";
import { isReplayable } from "./shape.ts";

export { spec };

export interface Env {
  /** Notion internal integration token (secret: `wrangler secret put NOTION_TOKEN`). */
  NOTION_TOKEN: string;
  /** e.g. "your-team.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access app protecting this Worker. */
  ACCESS_AUD: string;
  /**
   * Optional: Notion page ID of the workspace's governance README. When set, the
   * governance_bundle tool is registered; it resolves stores and guides from that page's tables.
   */
  GOVERNANCE_README_ID?: string;
}

export interface NotionRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | (string | number | boolean)[] | undefined>;
  body?: unknown;
  contentType?: string;
  rawBody?: boolean;
  /** Skip the schema-cache read (the live result is still stored, generation guard permitting). For reads that must be live. */
  noCache?: boolean;
  /** Opt-in Notion API betas, sent as the Notion-Beta header. Allowlisted in beta.ts. */
  betas?: string[];
}

const NOTION_ORIGIN = "https://api.notion.com";
const DEFAULT_NOTION_VERSION = "2025-09-03";

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
// Schema cache: GET /v1/databases/{id} and /v1/data_sources/{id} (no query string)
// are kept for a few minutes per Worker isolate, so repeated schema reads don't spend
// Notion's rate limit. A schema write (any non-GET to a database or data source other than a
// query) clears the whole cache, since a database write can change its data sources. In-memory
// only: it needs no binding and is lost when the isolate is recycled, which is harmless.
//
// Generation guard: a schema write bumps `schemaGen` and clears the cache both before it is sent
// and once it has finished. A cacheable GET stores its result only if the generation is
// unchanged since it started, so a read that overlaps a write can't leave pre-write data cached.
// ---------------------------------------------------------------------------
/** How long a cached schema is served. One constant so it can be tuned from the `cache` log field. */
export const SCHEMA_TTL_MS = 5 * 60_000;
const SCHEMA_PATH = /^\/v1\/(databases|data_sources)\/[^/]+$/;
export const schemaCache = new Map<string, { data: unknown; expires: number }>();
let schemaGen = 0;

function schemaCacheKey(method: string, url: URL): string | null {
  return method === "GET" && !url.search && SCHEMA_PATH.test(url.pathname) ? url.pathname : null;
}

/** A write that can change a cached schema: a non-GET under /v1/databases/ or /v1/data_sources/, except queries. */
export function isSchemaWrite(method: string, path: string): boolean {
  return method !== "GET" && /^\/v1\/(databases|data_sources)\//.test(path) && !path.endsWith("/query");
}

/**
 * How a cacheable schema GET was answered, logged as `cache` on its notion_call line:
 * hit (served from the cache), miss (no entry), expired (an entry past its TTL),
 * bypass (noCache asked for a live read).
 */
type CacheStatus = "hit" | "miss" | "expired" | "bypass";

/**
 * One structured line per Notion call, for Workers Logs: where the time goes (Notion, retries,
 * cache). Path only (no query string, body or headers), so no token or content is logged.
 */
function logCall(fields: Record<string, unknown>): void {
  console.log({ event: "notion_call", ...fields });
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
  // Validated before anything is sent: a malformed or unlisted flag never reaches Notion.
  const beta = betaHeader(opts.betas);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    // Arrays repeat the key, which is how Notion takes several filter_properties.
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }

  // A beta can change a response's shape, so beta reads neither use nor fill the schema cache.
  const cacheKey = beta ? null : schemaCacheKey(opts.method, url);
  const schemaWrite = isSchemaWrite(opts.method, url.pathname);
  let cache: { cache?: CacheStatus } = {};
  if (schemaWrite) {
    schemaGen++;
    schemaCache.clear();
  } else if (cacheKey) {
    if (opts.noCache) cache = { cache: "bypass" };
    else {
      const entry = schemaCache.get(cacheKey);
      if (entry && entry.expires > Date.now()) {
        logCall({ method: opts.method, path: url.pathname, cached: true, cache: "hit", ms: 0 });
        return entry.data;
      }
      cache = { cache: entry ? "expired" : "miss" };
    }
  }
  const gen = schemaGen;
  try {
    return await send(env, opts, url, beta, cacheKey, gen, cache);
  } finally {
    // A GET that overlapped this write may hold pre-write data: the bump stops one still in
    // flight from storing it, and the clear drops one that already finished and stored it.
    if (schemaWrite) {
      schemaGen++;
      schemaCache.clear();
    }
  }
}

async function send(
  env: Env,
  opts: NotionRequest,
  url: URL,
  beta: string | undefined,
  cacheKey: string | null,
  gen: number,
  cache: { cache?: CacheStatus },
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": notionVersionFor(opts.method, url.pathname),
  };
  if (beta) headers["Notion-Beta"] = beta;
  let body: BodyInit | undefined;
  if (opts.body !== undefined && opts.method !== "GET") {
    headers["Content-Type"] = opts.contentType ?? "application/json";
    body = opts.rawBody ? (opts.body as BodyInit) : JSON.stringify(opts.body);
  }

  const idempotent = isReplayable(opts.method, url.pathname);
  const betas = beta ? { betas: beta.split(",") } : {};
  const started = Date.now();
  let res: Response;
  let retries: number;
  try {
    ({ res, retries } = await fetchWithRetry(() => fetch(url, { method: opts.method, headers, body }), { idempotent }));
  } catch (e) {
    logCall({ method: opts.method, path: url.pathname, ...betas, cached: false, ...cache, ms: Date.now() - started, status: 0, error: "network" });
    throw e;
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  const err = data as { code?: string; message?: string };
  logCall({
    method: opts.method,
    path: url.pathname,
    ...betas,
    cached: false,
    ...cache,
    ms: Date.now() - started,
    status: res.status,
    retries,
    ...(res.ok ? {} : { code: err?.code }),
  });
  if (!res.ok) {
    // Surface Notion's error (code + message) so the model can self-correct.
    const hint = res.status === 400 ? await databaseHint(env, err?.message) : "";
    throw new Error(
      `Notion API ${res.status} ${err?.code ?? ""}: ${err?.message ?? text}`.trim() +
        errorTag(res.status, err?.code, res.headers.get("Retry-After"), idempotent) +
        hint +
        (res.status === 400 ? betaHint(err?.message, opts.betas) : ""),
    );
  }
  // Stored only if no schema write started or finished since this read began (generation guard).
  if (cacheKey && gen === schemaGen) schemaCache.set(cacheKey, { data, expires: Date.now() + SCHEMA_TTL_MS });
  return data;
}

const DATABASE_NOT_PAGE = /Provided ID ([0-9a-f-]{32,36}) is a database, not a page/i;

/**
 * A database id sent to a page endpoint (GET /v1/pages/{id}/markdown is the usual one) fails
 * with "is a database, not a page". The rows live in the database's data source, whose id the
 * caller rarely has, so look it up once (a cached schema read) and name the call to make.
 */
async function databaseHint(env: Env, message: string | undefined): Promise<string> {
  const id = message?.match(DATABASE_NOT_PAGE)?.[1];
  if (!id) return "";
  try {
    const db = (await notionRequest(env, { method: "GET", path: `/v1/databases/${id}` })) as {
      data_sources?: { id: string; name?: string }[];
    };
    const sources = db.data_sources ?? [];
    if (sources.length) {
      const list = sources.map((s) => `POST /v1/data_sources/${s.id}/query${s.name ? ` ("${s.name}")` : ""}`).join("; ");
      return ` Its rows: ${list}. Its schema: GET /v1/data_sources/{id}.`;
    }
  } catch {
    /* fall through to the generic hint */
  }
  return ` Read it with GET /v1/databases/${id}; query rows with POST /v1/data_sources/{id}/query using an id from its data_sources[].`;
}

export const NOTION_NOTES = `
Notion API notes:
- Paths start with /v1/ (e.g. /v1/search, /v1/pages/{id}). The Notion-Version header is set automatically.
- Databases are containers for data sources. Query rows with POST /v1/data_sources/{data_source_id}/query
  (get data source ids from GET /v1/databases/{database_id} -> data_sources[]).
- For readable page content prefer GET /v1/pages/{id}/markdown; edit it with PATCH /v1/pages/{id}/markdown.
- List endpoints paginate: pass start_cursor from next_cursor while has_more is true (page_size max 100).
- Return only the properties you need: query { filter_properties: ["Name", "Status"] } (names or ids)
  on data source queries and page reads. With format "values" this is the cheapest way to read rows.
- A list too long for one reply is fetched again with a smaller page_size, so you still get whole rows and a
  next_cursor that skips nothing (page_size_reduced_to says what was used). Keep following next_cursor while
  has_more is true. Use format "values" or filter_properties to fit more rows per reply.
- Other long results (such as page Markdown) end with "…[truncated … offset=N]": call again with the same
  arguments plus offset=N.
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
