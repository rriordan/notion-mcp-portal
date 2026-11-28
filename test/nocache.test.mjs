// The 5-minute schema cache: noCache bypasses it, schema writes clear it, and the generation
// guard keeps a read that overlaps a write from refilling it with pre-write data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isSchemaWrite, notionRequest, schemaCache } from "../src/notion.ts";

const env = { NOTION_TOKEN: "t" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

/** A fake fetch whose replies are released by hand, so tests can order overlapping calls. */
function deferredFetch() {
  const pending = [];
  const calls = [];
  const fake = (url, init) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${new URL(url).pathname}`);
    return new Promise((resolve) => pending.push({ method, resolve }));
  };
  /** Resolve the oldest pending call with that method. */
  const release = async (method, obj) => {
    const i = pending.findIndex((p) => p.method === method);
    assert.ok(i >= 0, `no pending ${method}`);
    pending.splice(i, 1)[0].resolve(json(obj));
  };
  return { fake, calls, release };
}

/** Let queued microtasks (and the fetch call inside notionRequest) run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

async function withFetch(fake, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake;
  schemaCache.clear();
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    schemaCache.clear();
  }
}

test("a schema read in flight during a write does not refill the cache", async () => {
  const d = deferredFetch();
  await withFetch(d.fake, async () => {
    const get = notionRequest(env, { method: "GET", path: "/v1/data_sources/x" });
    await tick();
    const patch = notionRequest(env, { method: "PATCH", path: "/v1/data_sources/x", body: {} });
    await tick();
    await d.release("PATCH", { id: "x", v: "new" });
    await patch;
    await d.release("GET", { id: "x", v: "old" });
    assert.equal((await get).v, "old");
    // The next read must go to Notion, not serve the pre-write copy.
    const next = notionRequest(env, { method: "GET", path: "/v1/data_sources/x" });
    await tick();
    await d.release("GET", { id: "x", v: "new" });
    assert.equal((await next).v, "new");
    assert.equal(d.calls.filter((c) => c.startsWith("GET")).length, 2);
  });
});

test("a GET that starts while a write is in flight does not cache", async () => {
  const d = deferredFetch();
  await withFetch(d.fake, async () => {
    const patch = notionRequest(env, { method: "PATCH", path: "/v1/data_sources/x", body: {} });
    await tick();
    const get = notionRequest(env, { method: "GET", path: "/v1/data_sources/x" });
    await tick();
    await d.release("GET", { id: "x", v: "old" });
    await get;
    await d.release("PATCH", { id: "x", v: "new" });
    await patch;
    const next = notionRequest(env, { method: "GET", path: "/v1/data_sources/x" });
    await tick();
    assert.equal(d.calls.filter((c) => c.startsWith("GET")).length, 2, "the second GET went to Notion");
    await d.release("GET", { id: "x", v: "new" });
    assert.equal((await next).v, "new");
  });
});

test("a database write clears its data sources' cached schemas", async () => {
  let calls = 0;
  await withFetch(async () => (calls++, json({ id: "ds" })), async () => {
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/ds" });
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/ds" });
    assert.equal(calls, 1);
    await notionRequest(env, { method: "PATCH", path: "/v1/databases/db", body: {} });
    assert.equal(schemaCache.size, 0);
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/ds" });
    assert.equal(calls, 3);
  });
});

test("a query POST or a page write does not clear the schema cache", async () => {
  let calls = 0;
  await withFetch(async () => (calls++, json({ object: "list", results: [] })), async () => {
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/ds" });
    await notionRequest(env, { method: "POST", path: "/v1/data_sources/ds/query", body: {} });
    await notionRequest(env, { method: "PATCH", path: "/v1/pages/p", body: {} });
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/ds" });
    assert.equal(calls, 3, "the second schema read was a cache hit");
  });
  assert.equal(isSchemaWrite("POST", "/v1/databases/db/query"), false);
  assert.equal(isSchemaWrite("PATCH", "/v1/data_sources/ds"), true);
  assert.equal(isSchemaWrite("GET", "/v1/data_sources/ds"), false);
});

// A page write that sets a select value Notion doesn't know adds that option to the parent schema.
for (const [method, path] of [
  ["POST", "/v1/pages"],
  ["PATCH", "/v1/pages/p"],
]) {
  test(`a ${method} ${path} that sets properties clears the schema cache`, async () => {
    const before = { object: "data_source", id: "ds", properties: { Tag: { type: "select", select: { options: [{ name: "Old" }] } } } };
    const after = { ...before, properties: { Tag: { type: "select", select: { options: [{ name: "Old" }, { name: "New" }] } } } };
    let schema = before;
    const calls = [];
    const realLog = console.log;
    const logged = [];
    console.log = (...args) => logged.push(args[0]);
    try {
      await withFetch(
        async (url, init) => {
          const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
          calls.push(key);
          if (key === "GET /v1/data_sources/ds") return json(schema);
          schema = after; // Notion adds the option as part of the page write.
          return json({ object: "page", id: "p" });
        },
        async () => {
          await notionRequest(env, { method: "GET", path: "/v1/data_sources/ds" });
          const body = { ...(method === "POST" ? { parent: { data_source_id: "ds" } } : {}), properties: { Tag: { select: { name: "New" } } } };
          await notionRequest(env, { method, path, body });
          const next = await notionRequest(env, { method: "GET", path: "/v1/data_sources/ds" });
          assert.deepEqual(
            next.properties.Tag.select.options.map((o) => o.name),
            ["Old", "New"],
          );
          assert.equal(calls.filter((c) => c === "GET /v1/data_sources/ds").length, 2, "fetched again");
        },
      );
    } finally {
      console.log = realLog;
    }
    const schemaLines = logged.filter((l) => l?.event === "notion_call" && l.path === "/v1/data_sources/ds");
    assert.deepEqual(
      schemaLines.map((l) => l.cache),
      ["miss", "miss"],
    );
  });
}

test("a page PATCH without properties leaves the schema cache alone", async () => {
  let calls = 0;
  await withFetch(async () => (calls++, json({ object: "page", id: "p" })), async () => {
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/ds" });
    await notionRequest(env, { method: "PATCH", path: "/v1/pages/p", body: { archived: true, icon: { emoji: "x" } } });
    await notionRequest(env, { method: "PATCH", path: "/v1/pages/p", body: { properties: {} } });
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/ds" });
    assert.equal(calls, 3, "the second schema read was a cache hit");
  });
  assert.equal(isSchemaWrite("POST", "/v1/pages", { properties: { Name: { title: [] } } }), true);
  assert.equal(isSchemaWrite("PATCH", "/v1/pages/p", { properties: { Tag: { select: { name: "N" } } } }), true);
  assert.equal(isSchemaWrite("PATCH", "/v1/pages/p", { in_trash: true }), false);
  assert.equal(isSchemaWrite("PATCH", "/v1/pages/p/markdown", { properties: { Tag: {} } }), false);
  assert.equal(isSchemaWrite("POST", "/v1/pages/p/move", { properties: { Tag: {} } }), false);
  assert.equal(isSchemaWrite("GET", "/v1/pages/p", { properties: { Tag: {} } }), false);
});

test("schema reads log cache: miss, hit, expired or bypass; other calls carry no cache field", async () => {
  const realLog = console.log;
  const realNow = Date.now;
  const logged = [];
  console.log = (...args) => logged.push(args);
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await withFetch(async () => json({ id: "z" }), async () => {
      await notionRequest(env, { method: "GET", path: "/v1/data_sources/z" }); // miss
      await notionRequest(env, { method: "GET", path: "/v1/data_sources/z" }); // hit
      now += 5 * 60_000 + 1;
      await notionRequest(env, { method: "GET", path: "/v1/data_sources/z" }); // expired
      await notionRequest(env, { method: "GET", path: "/v1/data_sources/z", noCache: true }); // bypass
      await notionRequest(env, { method: "GET", path: "/v1/pages/p" });
    });
  } finally {
    console.log = realLog;
    Date.now = realNow;
  }
  const lines = logged.map((a) => a[0]).filter((x) => x?.event === "notion_call");
  assert.deepEqual(
    lines.map((l) => l.cache),
    ["miss", "hit", "expired", "bypass", undefined],
  );
  assert.deepEqual(
    lines.map((l) => l.cached),
    [false, true, false, false, false],
  );
});

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
