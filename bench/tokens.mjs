// Token benchmark: how many tokens the model pays for this server's tool definitions and
// for typical tool results, measured with the Anthropic token-counting API.
//
//   npm run bench              -> count tokens (needs ANTHROPIC_API_KEY)
//   npm run bench -- --no-count -> only fetch and show character counts (no API key needed)
//
// Setup is in bench/README.md.
import { readFile, writeFile } from "node:fs/promises";
import { rowCount, savedCell } from "./saved.mjs";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.BENCH_MCP_URL ?? "http://127.0.0.1:8787/mcp";
const MODEL = process.env.BENCH_MODEL ?? "claude-opus-5-5";
const COUNT = !process.argv.includes("--no-count");
const here = (p) => new URL(p, import.meta.url);

// --- Load the calls, filling ${VAR} placeholders from the environment -----------------
// BENCH_CALLS="users_me,page" runs only those calls (placeholders of skipped calls need no env vars).
const only = process.env.BENCH_CALLS?.split(",").map((s) => s.trim()).filter(Boolean);
const allCalls = JSON.parse(await readFile(here("calls.json"), "utf8"));
if (only) {
  const unknown = only.filter((n) => !allCalls.some((c) => c.name === n));
  if (unknown.length) throw new Error(`BENCH_CALLS names no such call: ${unknown.join(", ")}`);
}
const calls = (only ? allCalls.filter((c) => only.includes(c.name)) : allCalls).map((c) =>
  JSON.parse(
    JSON.stringify(c).replace(/\$\{(\w+)\}/g, (_, name) => {
      if (!process.env[name]) throw new Error(`Set ${name} (see bench/README.md)`);
      return JSON.stringify(process.env[name]).slice(1, -1);
    }),
  ),
);

// --- Fetch our tool definitions and each call's result over MCP ----------------------
// This goes through the real MCP handler, so the text is exactly what a model receives.
const mcp = new Client({ name: "notion-mcp-portal-bench", version: "1.0.0" });
// BENCH_HEADERS='{"CF-Access-Client-Id":"...","CF-Access-Client-Secret":"..."}' lets the bench reach a deployed
// server behind Cloudflare Access; leave it unset for the local dev server.
const headers = process.env.BENCH_HEADERS ? JSON.parse(process.env.BENCH_HEADERS) : undefined;
await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), headers ? { requestInit: { headers } } : undefined));
// BENCH_TOOL_PREFIX="notion-api_" for a portal that prefixes each server's tools: keep only this server's tools
// and count them under their own names, so the numbers match the direct server.
const PREFIX = process.env.BENCH_TOOL_PREFIX ?? "";
const tools = (await mcp.listTools()).tools
  .filter((t) => t.name.startsWith(PREFIX))
  .map((t) => ({ ...t, name: t.name.slice(PREFIX.length) }));

const results = [];
for (const call of calls) {
  // A call with "tool" goes to that tool once, with "arguments" (no raw/compact pair to compare).
  if (call.tool) {
    if (!tools.some((t) => t.name === call.tool)) {
      console.log(`Skipping ${call.name}: ${call.tool} is not listed by this server`);
      continue;
    }
    const res = await mcp.callTool({ name: PREFIX + call.tool, arguments: call.arguments ?? {} });
    const t = res.content.map((c) => c.text ?? "").join("");
    if (res.isError) throw new Error(`${call.name} failed: ${t}`);
    results.push({ name: call.name, raw: null, compact: t });
    continue;
  }
  const { name, ...args } = call;
  // Each call twice: format "raw" (Notion's full JSON) and the default compact output.
  const get = async (format) => {
    const res = await mcp.callTool({ name: PREFIX + "notion_request", arguments: { ...args, format } });
    const t = res.content.map((c) => c.text ?? "").join("");
    if (res.isError) throw new Error(`${name} failed: ${t}`);
    return t;
  };
  results.push({ name, raw: await get("raw"), compact: await get("compact") });
}
await mcp.close();

// --- Optional: the official connector's tool definitions, exported to a file ---------
let official = null;
try {
  official = JSON.parse(await readFile(here("official-tools.json"), "utf8"));
} catch {
  /* not exported; skipped */
}

// MCP tool -> the shape the Anthropic API takes
const toApiTool = (t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema ?? t.input_schema });

// --- Count tokens -------------------------------------------------------------------
// Each count is measured against a one-character baseline message, so the numbers
// cover only the tool definitions or the result text, not the request's fixed overhead.
const anthropic = COUNT ? new Anthropic() : null;
const messages = (text) => [{ role: "user", content: text }];
const baseline = COUNT ? (await anthropic.messages.countTokens({ model: MODEL, messages: messages(".") })).input_tokens : 0;

async function textTokens(text) {
  if (!COUNT || text === null) return null;
  const { input_tokens } = await anthropic.messages.countTokens({ model: MODEL, messages: messages(text) });
  return input_tokens - baseline;
}

async function toolTokens(list) {
  if (!COUNT || !list) return null;
  const { input_tokens } = await anthropic.messages.countTokens({ model: MODEL, tools: list.map(toApiTool), messages: messages(".") });
  return input_tokens - baseline;
}

const report = {
  date: new Date().toISOString().slice(0, 10),
  model: COUNT ? MODEL : null,
  tools: {
    ours: { count: tools.length, tokens: await toolTokens(tools) },
    official: official ? { count: official.length, tokens: await toolTokens(official) } : null,
  },
  calls: [],
};
// The server cuts results at 24,000 chars; a cut result is marked so its size isn't mistaken for the whole.
const measure = async (t) => ({ chars: t.length, tokens: await textTokens(t), truncated: t.includes("…[truncated "), rows: rowCount(t) });
for (const r of results) {
  report.calls.push({ name: r.name, raw: r.raw === null ? null : await measure(r.raw), compact: await measure(r.compact) });
}

// --- Print a Markdown table and save the numbers ------------------------------------
const unit = COUNT ? "tokens" : "chars";
const n = (x) => `${(COUNT ? x.tokens : x.chars).toLocaleString("en-US")}${x.truncated ? " (truncated)" : ""}`;
console.log(`\nTool definitions (${unit}, ${report.model ?? "no count"})\n`);
console.log("| Server | Tools | Tokens |\n|---|---|---|");
console.log(`| notion-mcp-portal | ${report.tools.ours.count} | ${report.tools.ours.tokens ?? "n/a"} |`);
console.log(`| Official connector | ${official ? official.length : "not exported"} | ${report.tools.official?.tokens ?? "n/a"} |`);
console.log(`\nTool results (${unit})\n`);
console.log("| Call | Raw | Compact (default) | Saved |\n|---|---|---|---|");
for (const c of report.calls) {
  if (!c.raw) {
    console.log(`| ${c.name} | n/a | ${n(c.compact)} | n/a |`);
    continue;
  }
  const side = (x) => ({ size: COUNT ? x.tokens : x.chars, rows: x.rows, truncated: x.truncated });
  const saved = savedCell(side(c.raw), side(c.compact));
  console.log(`| ${c.name} | ${n(c.raw)} | ${n(c.compact)} | ${saved} |`);
}
if (COUNT) {
  await writeFile(here("results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("\nSaved bench/results.json");
}
