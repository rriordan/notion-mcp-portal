// timing: one log line per tool call, with the tool, the milliseconds and the error flag, and nothing else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timed } from "../src/timing.ts";

function clock(...ticks) {
  let i = 0;
  return () => ticks[i++];
}

test("logs the tool, the elapsed ms and error:false, and returns the reply untouched", async () => {
  const lines = [];
  const reply = { content: [{ type: "text", text: "secret page text" }] };
  const run = timed("notion_request", async (a) => ({ ...reply, echo: a }), clock(100, 598), (l) => lines.push(l));
  const out = await run({ path: "/v1/pages/abc" });
  assert.deepEqual(out.content, reply.content);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { event: "tool_call", tool: "notion_request", ms: 498, error: false });
  assert.ok(!lines[0].includes("secret") && !lines[0].includes("abc"), "no request or reply content in the line");
});

test("an isError reply is logged as error:true", async () => {
  const lines = [];
  const run = timed("governance_bundle", async () => ({ isError: true, content: [] }), clock(0, 5), (l) => lines.push(l));
  await run();
  assert.equal(JSON.parse(lines[0]).error, true);
});

test("a thrown error is logged and still thrown", async () => {
  const lines = [];
  const run = timed("notion_find_endpoints", async () => { throw new Error("boom"); }, clock(0, 3), (l) => lines.push(l));
  await assert.rejects(run(), /boom/);
  assert.deepEqual(JSON.parse(lines[0]), { event: "tool_call", tool: "notion_find_endpoints", ms: 3, error: true });
});
