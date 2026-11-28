// Per-call timeouts through the real Worker, against the mock Notion (test/mock-notion.ts).
// The mock config sets NOTION_TIMEOUT_MS=300 (reads 300 ms, writes 900 ms); /v1/pages/mock-slow
// answers only after 3 s.
//   SMOKE_MCP_URL=http://127.0.0.1:8788/mcp node test/timeout-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.SMOKE_MCP_URL ?? "http://127.0.0.1:8788/mcp";
const SLOW = "/v1/pages/mock-slow";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const call = async (args) => {
  try {
    const r = await mcp.callTool({ name: "notion_request", arguments: args });
    return { isError: !!r.isError, text: r.content.map((c) => c.text ?? "").join("") };
  } catch (e) {
    return { isError: true, text: String(e?.message ?? e) };
  }
};
const count = async (route) => {
  const r = await call({ method: "GET", path: "/v1/mock/calls", format: "raw" });
  return JSON.parse(r.text).calls[route] ?? 0;
};

const mcp = new Client({ name: "notion-mcp-timeout-e2e", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(URL_)));

const get0 = await count(`GET ${SLOW}`);
const t0 = Date.now();
const read = await call({ method: "GET", path: SLOW });
const readMs = Date.now() - t0;
const gets = (await count(`GET ${SLOW}`)) - get0;
check("a slow read fails with class=timeout", read.isError && /class=timeout; retryable later/.test(read.text), read.text.slice(0, 160));
check("a slow read is tried twice", gets === 2, `${gets} calls`);
check("a slow read gives up well before the mock replies", readMs < 2_500, `${readMs} ms`);

const patch0 = await count(`PATCH ${SLOW}`);
const write = await call({ method: "PATCH", path: SLOW, body: { archived: false } });
const patches = (await count(`PATCH ${SLOW}`)) - patch0;
check("a slow write says it may have landed", write.isError && /class=timeout.*may have landed.*don't resend just because a first read-back shows nothing/.test(write.text), write.text.slice(0, 200));
check("a slow write is sent once", patches === 1, `${patches} calls`);

const fast = await call({ method: "POST", path: "/v1/data_sources/mock-ds/query", body: { page_size: 5 }, format: "values" });
check("a fast call is unaffected", !fast.isError, fast.isError ? fast.text.slice(0, 120) : "");

await mcp.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
