// governance_bundle end to end through MCP, against the mock Notion (npm run test:e2e).
//   SMOKE_MCP_URL=http://127.0.0.1:8788/mcp node test/bundle-e2e.mjs
// BUNDLE_EXPECT=absent checks the tool is NOT listed (a deployment without GOVERNANCE_README_ID).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.SMOKE_MCP_URL ?? "http://127.0.0.1:8788/mcp";
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const mcp = new Client({ name: "notion-mcp-bundle-e2e", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(URL_)));
const tools = (await mcp.listTools()).tools.map((t) => t.name);

if (process.env.BUNDLE_EXPECT === "absent") {
  check("governance_bundle not listed without GOVERNANCE_README_ID", !tools.includes("governance_bundle"), tools.join(", "));
  check("existing tools still listed", tools.includes("notion_request") && tools.includes("notion_find_endpoints"));
} else {
  check("governance_bundle listed", tools.includes("governance_bundle"), tools.join(", "));
  if (tools.includes("governance_bundle")) {
    const call = async (args) => {
      const r = await mcp.callTool({ name: "governance_bundle", arguments: args });
      return { isError: Boolean(r.isError), raw: r.content?.[0]?.text ?? "" };
    };
    const clean = await call({});
    let b = null;
    try {
      b = JSON.parse(clean.raw);
    } catch {}
    check("no-arg call returns JSON", !clean.isError && b !== null, clean.raw.slice(0, 200));
    check("errors is the first key and empty", b && Object.keys(b)[0] === "errors" && b.errors.length === 0, JSON.stringify(b?.errors));
    check("readme markdown present", typeof b?.readme?.markdown === "string" && b.readme.markdown.length > 0);
    check("field rules carry descriptions", Boolean(b?.activity_log_fields?.fields?.some((f) => f.description)));
    check("preferences rows without Evidence", Array.isArray(b?.preferences?.rows) && b.preferences.rows.length > 0 && !("Evidence" in b.preferences.rows[0]));

    const bad = await call({ scope: "Nope" });
    let nb = null;
    try {
      nb = JSON.parse(bad.raw);
    } catch {}
    check("unknown scope is not a tool error", !bad.isError && nb !== null, bad.raw.slice(0, 200));
    check("unknown scope nulls preferences and says why", nb?.preferences === null && nb.errors.some((e) => e.section === "preferences"));
  }
}
await mcp.close();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
