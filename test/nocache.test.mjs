// noCache bypasses the 5-minute schema cache, so governance reads are live.
import assert from "node:assert/strict";
import { test } from "node:test";
import { notionRequest, schemaCache } from "../src/notion.ts";

test("noCache skips the schema cache read", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ object: "data_source", id: "x" }), { status: 200 });
  };
  try {
    schemaCache.clear();
    const env = { NOTION_TOKEN: "t" };
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/x" });
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/x" });
    assert.equal(calls, 1);
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/x", noCache: true });
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/x", noCache: true });
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = realFetch;
    schemaCache.clear();
  }
});

// One structured log line per Notion call, so Workers Logs shows where the time goes.
test("each Notion call logs method, path, status, duration and retries", async () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args);
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return n === 1
      ? new Response("{}", { status: 503 })
      : new Response(JSON.stringify({ object: "list", results: [] }), { status: 200 });
  };
  try {
    schemaCache.clear();
    await notionRequest({ NOTION_TOKEN: "t" }, { method: "POST", path: "/v1/data_sources/x/query", query: { filter_properties: ["A"] } });
    globalThis.fetch = async () => new Response(JSON.stringify({ object: "error", code: "object_not_found", message: "no" }), { status: 404 });
    await assert.rejects(notionRequest({ NOTION_TOKEN: "t" }, { method: "GET", path: "/v1/pages/missing" }));
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  const lines = logged.map((a) => a[0]).filter((x) => x?.event === "notion_call");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].method, "POST");
  assert.equal(lines[0].path, "/v1/data_sources/x/query");
  assert.equal(lines[0].status, 200);
  assert.equal(lines[0].retries, 1);
  assert.equal(typeof lines[0].ms, "number");
  assert.equal(lines[1].status, 404);
  assert.equal(lines[1].code, "object_not_found");
  assert.ok(!JSON.stringify(lines).includes("Bearer"), "never logs the token");
});

test("a schema-cache hit logs as cached, with no Notion call", async () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args);
  globalThis.fetch = async () => new Response(JSON.stringify({ object: "data_source", id: "y" }), { status: 200 });
  try {
    schemaCache.clear();
    await notionRequest({ NOTION_TOKEN: "t" }, { method: "GET", path: "/v1/data_sources/y" });
    await notionRequest({ NOTION_TOKEN: "t" }, { method: "GET", path: "/v1/data_sources/y" });
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    schemaCache.clear();
  }
  const lines = logged.map((a) => a[0]).filter((x) => x?.event === "notion_call");
  assert.deepEqual(
    lines.map((l) => l.cached === true),
    [false, true],
  );
});
