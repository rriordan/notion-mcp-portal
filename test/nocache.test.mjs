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
