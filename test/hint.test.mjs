// Run with: npm test
// Regression test: an agent asked for GET /v1/pages/{id}/markdown with a database id and got
// "400 validation_error: Provided ID … is a database, not a page". The error now says where the
// rows are: the database's data source id, looked up once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { notionRequest, schemaCache } from "../src/notion.ts";

const DB = "fa4a3692-1dad-411e-84e4-d8c7eeb0d664";
const isDatabase = () =>
  new Response(
    JSON.stringify({ object: "error", code: "validation_error", message: `Provided ID ${DB} is a database, not a page. Use the retrieve database API instead.` }),
    { status: 400 },
  );

async function withFetch(handler, fn) {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  console.log = () => {};
  globalThis.fetch = handler;
  try {
    schemaCache.clear();
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    schemaCache.clear();
  }
}

test("a database id sent to a page endpoint gets its data source id in the error", async () => {
  const seen = [];
  await withFetch(
    async (url) => {
      seen.push(new URL(url).pathname);
      return seen.length === 1
        ? isDatabase()
        : new Response(JSON.stringify({ object: "database", id: DB, data_sources: [{ id: "f0ec65d3-696a-477e-973f-5b1271b86b32", name: "Activity Log" }] }), { status: 200 });
    },
    async () => {
      await assert.rejects(notionRequest({ NOTION_TOKEN: "t" }, { method: "GET", path: `/v1/pages/${DB.replace(/-/g, "")}/markdown` }), (e) => {
        assert.match(e.message, /is a database, not a page/);
        assert.match(e.message, /POST \/v1\/data_sources\/f0ec65d3-696a-477e-973f-5b1271b86b32\/query/);
        assert.match(e.message, /Activity Log/);
        assert.match(e.message, /class=invalid_request/);
        return true;
      });
    },
  );
  assert.deepEqual(seen, [`/v1/pages/${DB.replace(/-/g, "")}/markdown`, `/v1/databases/${DB}`]);
});

test("if the database lookup fails, the error still says how to find the rows", async () => {
  let n = 0;
  await withFetch(
    async () => (++n === 1 ? isDatabase() : new Response(JSON.stringify({ object: "error", code: "object_not_found", message: "no" }), { status: 404 })),
    async () => {
      await assert.rejects(notionRequest({ NOTION_TOKEN: "t" }, { method: "GET", path: `/v1/pages/${DB}` }), (e) => {
        assert.match(e.message, new RegExp(`GET /v1/databases/${DB}`));
        assert.match(e.message, /data_sources/);
        return true;
      });
    },
  );
  assert.equal(n, 2);
});

test("a database with no data sources still gets the generic hint", async () => {
  let n = 0;
  await withFetch(
    async () => (++n === 1 ? isDatabase() : new Response(JSON.stringify({ object: "database", id: DB, data_sources: [] }), { status: 200 })),
    async () => {
      await assert.rejects(notionRequest({ NOTION_TOKEN: "t" }, { method: "GET", path: `/v1/pages/${DB}` }), (e) => {
        assert.match(e.message, new RegExp(`GET /v1/databases/${DB}`));
        assert.doesNotMatch(e.message, /Its rows:/);
        return true;
      });
    },
  );
  assert.equal(n, 2);
});

test("other 400s get no extra lookup", async () => {
  let n = 0;
  await withFetch(
    async () => {
      n++;
      return new Response(JSON.stringify({ object: "error", code: "validation_error", message: "body.x should be not present" }), { status: 400 });
    },
    async () => {
      await assert.rejects(notionRequest({ NOTION_TOKEN: "t" }, { method: "POST", path: "/v1/data_sources/x/query", body: { x: 1 } }), (e) => !/data_sources\[\]/.test(e.message));
    },
  );
  assert.equal(n, 1);
});
