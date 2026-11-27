// Opt-in betas through the real Worker and MCP schema, against the mock Notion (test/mock-notion.ts).
// The mock answers status group filters the way Notion does with and without the beta header.
//   SMOKE_MCP_URL=http://127.0.0.1:8788/mcp node test/beta-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.SMOKE_MCP_URL ?? "http://127.0.0.1:8788/mcp";
const STATUS = "status-group-filters-2026-10-06";
const groupQuery = (extra = {}) => ({
  method: "POST",
  path: "/v1/data_sources/mock-status/query",
  body: { filter: { property: "Status", status: { group_equals: "In progress" } } },
  format: "values",
  ...extra,
});

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
    // Some SDK versions raise schema failures instead of returning isError.
    return { isError: true, text: String(e?.message ?? e) };
  }
};

const mcp = new Client({ name: "notion-mcp-beta-e2e", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(URL_)));

const { tools } = await mcp.listTools();
const schema = tools.find((t) => t.name === "notion_request")?.inputSchema?.properties?.betas;
check("tool schema lists the allowlisted beta", JSON.stringify(schema ?? {}).includes(STATUS), JSON.stringify(schema?.items ?? schema));

const without = await call(groupQuery());
check("group filter without betas: Notion's error, plus the betas to pass", without.isError && without.text.includes(`betas: ["${STATUS}"]`), without.text.slice(0, 160));

const withBeta = await call(groupQuery({ betas: [STATUS] }));
let names = [];
try {
  names = JSON.parse(withBeta.text).results.map((r) => r.props.Name);
} catch {}
check("group filter with betas: only the group's rows", !withBeta.isError && names.join("|") === "Write spec|Review PR", withBeta.isError ? withBeta.text.slice(0, 160) : names.join(", "));

const unknown = await call(groupQuery({ betas: ["notion-as-code-2026-07-31"] }));
check("unlisted beta is rejected", unknown.isError, unknown.text.slice(0, 120));

const malformed = await call(groupQuery({ betas: [`${STATUS}\r\nX-Evil: 1`] }));
check("malformed beta is rejected", malformed.isError, malformed.text.slice(0, 120));

const plain = await call({ method: "POST", path: "/v1/data_sources/mock-ds/query", body: { page_size: 5 } });
check("a request without betas sends no Notion-Beta header", !plain.isError, plain.isError ? plain.text.slice(0, 120) : "");

await mcp.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
