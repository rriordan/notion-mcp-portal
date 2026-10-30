/**
 * Notion API MCP server (direct tools, no sandbox). Works on the Workers Free plan.
 *
 *   notion_find_endpoints -> keyword search over the Notion OpenAPI spec; pass
 *                            operation_id to get that endpoint's full parameter/body schema
 *   notion_request        -> call any Notion API endpoint (method, path, query, body)
 *
 * Security: a valid Cloudflare Access JWT is required on every request; the Notion
 * token is a Worker secret and never reaches the model.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { parseBody } from "./body";
import { compactNotion, withHint } from "./compact";
import { type Env, NOTION_NOTES, type Spec, gate, notionRequest, spec } from "./notion";
import { text } from "./text";

export type { Env };

const S = spec as unknown as Spec;
const MAX_MATCHES = 8; // endpoints returned per notion_find_endpoints search
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

type Op = {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  raw: Record<string, unknown>;
};

const OPS: Op[] = Object.entries(S.paths).flatMap(([path, ops]) =>
  Object.entries(ops)
    .filter(([m]) => (METHODS as readonly string[]).includes(m))
    .map(([m, op]) => ({
      method: m.toUpperCase(),
      path,
      operationId: op.operationId as string | undefined,
      summary: op.summary as string | undefined,
      description: op.description as string | undefined,
      raw: op,
    })),
);

/** Resolve local $refs (depth-limited) so the model sees concrete schemas. */
function resolveRefs(node: unknown, depth = 0): unknown {
  if (depth > 8 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, depth + 1));
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/")) {
    const target = obj.$ref
      .slice(2)
      .split("/")
      .reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], S);
    return resolveRefs(target, depth + 1);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveRefs(v, depth + 1)]));
}

function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "notion-api", version: "1.0.0" });

  server.registerTool(
    "notion_find_endpoints",
    {
      description:
        "Find Notion API endpoints. Pass `query` (keywords like 'query data source', 'comments', 'markdown') " +
        "to list matching endpoints, or `operation_id` to get one endpoint's full parameter and request-body schema. " +
        "Returns the top 8 matches. Call this before notion_request when unsure of the path or body shape.",
      inputSchema: {
        query: z.string().optional().describe("Keywords to match against path, summary and operationId"),
        operation_id: z.string().optional().describe("Return the full schema for this operationId"),
      },
    },
    async ({ query, operation_id }) => {
      if (operation_id) {
        const op = OPS.find((o) => o.operationId === operation_id);
        if (!op) return text(`No endpoint with operationId "${operation_id}"`, true);
        const raw = op.raw as { parameters?: unknown; requestBody?: unknown };
        return text({
          method: op.method,
          path: op.path,
          summary: op.summary,
          parameters: resolveRefs(raw.parameters),
          requestBody: resolveRefs(raw.requestBody),
        });
      }
      const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const scored = OPS.map((o) => {
        const hay = `${o.method} ${o.path} ${o.operationId ?? ""} ${o.summary ?? ""} ${o.description ?? ""}`.toLowerCase();
        return { o, score: words.length ? words.filter((w) => hay.includes(w)).length : 1 };
      })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_MATCHES);
      return text(
        scored.map(({ o }) => ({ method: o.method, path: o.path, operationId: o.operationId, summary: o.summary })),
      );
    },
  );

  server.registerTool(
    "notion_request",
    {
      description:
        "Call the Notion API. Example: { method: 'POST', path: '/v1/search', body: { query: 'Projects', page_size: 10 } }. " +
        "To read a page's content, use GET /v1/pages/{id}/markdown rather than block children." +
        NOTION_NOTES,
      inputSchema: {
        method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
        path: z.string().describe("API path starting with /v1/, with ids filled in"),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z
          .union([z.record(z.string(), z.unknown()), z.string()])
          .optional()
          .describe("JSON request body object for POST/PATCH"),
        format: z
          .enum(["compact", "raw"])
          .optional()
          .describe(
            "compact (default): nulls, ids of properties and options, and rich-text formatting removed; rich text as plain text. raw: Notion's full JSON (exact annotations, option ids)",
          ),
      },
    },
    async ({ method, path, query, body, format }) => {
      try {
        const data = await notionRequest(env, { method, path, query, body: parseBody(body) });
        return text(format === "raw" ? data : withHint(method, path, compactNotion(data)));
      } catch (e) {
        return text(String(e instanceof Error ? e.message : e), true);
      }
    },
  );

  return server;
}

/** MCP handling after authentication. Exported so a local test entry can exercise it. */
export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // SDK v2 handler: serves 2026-07-28 clients (server/discover) and 2025-era clients statelessly.
  return createMcpHandler(() => buildServer(env), { route: "/mcp" })(request, env, ctx);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return (await gate(request, env)) ?? handleMcp(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
