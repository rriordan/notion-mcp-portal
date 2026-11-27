// Opt-in Notion API betas: allowlisted flags in `betas` become the Notion-Beta header.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BETA_FLAGS, betaHeader, betaHint } from "../src/beta.ts";
import { notionRequest, schemaCache } from "../src/notion.ts";

const STATUS = "status-group-filters-2026-10-06";

test("the status group filters beta is allowlisted", () => {
  assert.ok(BETA_FLAGS.includes(STATUS));
});

test("betaHeader joins allowlisted flags; none means no header", () => {
  assert.equal(betaHeader([STATUS]), STATUS);
  assert.equal(betaHeader(undefined), undefined);
  assert.equal(betaHeader([]), undefined);
});

test("betaHeader rejects malformed flags, including header injection", () => {
  for (const bad of [
    "status-group-filters", // no revision date
    "Status-Group-Filters-2026-10-06", // not kebab-case
    "status_group_filters-2026-10-06",
    ` ${STATUS}`,
    `${STATUS},notion-as-code-2026-07-31`, // a list inside one flag
    `${STATUS}\r\nAuthorization: Bearer x`,
    "status-group-filters-2026-13-40",
    "",
  ]) {
    assert.throws(() => betaHeader([bad]), /malformed/, JSON.stringify(bad));
  }
  assert.throws(() => betaHeader([42]), /malformed/);
  assert.throws(() => betaHeader(STATUS), /array/);
});

test("betaHeader rejects well-formed flags that aren't allowlisted, and names the allowed ones", () => {
  for (const unknown of ["notion-as-code-2026-07-31", "status-group-filters-2026-01-01"]) {
    assert.throws(() => betaHeader([unknown]), (e) => /not enabled on this server/.test(e.message) && e.message.includes(STATUS));
  }
});

test("betaHeader rejects a flag given twice", () => {
  assert.throws(() => betaHeader([STATUS, STATUS]), /more than once/);
});

test("betaHint names the betas argument when Notion asks for an allowlisted flag", () => {
  const msg = `Status group operators require the "Notion-Beta: ${STATUS}" header. See https://developers.notion.com/reference/filter-data-source-entries.`;
  assert.match(betaHint(msg, undefined), /betas: \["status-group-filters-2026-10-06"\]/);
  assert.equal(betaHint(msg, [STATUS]), "", "no hint when the flag was already sent");
  assert.equal(betaHint('requires the "Notion-Beta: notion-as-code-2026-07-31" header', undefined), "");
  assert.equal(betaHint("Could not find property", undefined), "");
  assert.equal(betaHint(undefined, undefined), "");
});

/** Capture what notionRequest hands to fetch. */
async function capture(req, respond = () => new Response(JSON.stringify({ object: "list", results: [] }), { status: 200 })) {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond();
  };
  console.log = () => {};
  try {
    schemaCache.clear();
    const result = await notionRequest({ NOTION_TOKEN: "t" }, req).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    return { calls, ...result };
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    schemaCache.clear();
  }
}

test("a request with betas sends Notion-Beta beside the usual auth and version headers", async () => {
  const { calls, error } = await capture({
    method: "POST",
    path: "/v1/data_sources/x/query",
    body: { filter: { property: "Status", status: { group_equals: "In progress" } } },
    betas: [STATUS],
  });
  assert.equal(error, undefined);
  assert.equal(calls.length, 1);
  const h = calls[0].init.headers;
  assert.equal(h["Notion-Beta"], STATUS);
  assert.equal(h.Authorization, "Bearer t");
  assert.equal(h["Notion-Version"], "2025-09-03");
  assert.equal(h["Content-Type"], "application/json");
});

test("a request without betas is unchanged: no Notion-Beta header", async () => {
  for (const betas of [undefined, []]) {
    const { calls } = await capture({ method: "POST", path: "/v1/data_sources/x/query", body: {}, betas });
    assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ["Authorization", "Content-Type", "Notion-Version"]);
  }
  const { calls } = await capture({ method: "GET", path: "/v1/users/me" });
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ["Authorization", "Notion-Version"]);
});

test("a malformed or unknown flag is rejected before anything is sent to Notion", async () => {
  for (const betas of [["not a flag"], ["notion-as-code-2026-07-31"]]) {
    const { calls, error } = await capture({ method: "POST", path: "/v1/data_sources/x/query", body: {}, betas });
    assert.ok(error instanceof Error);
    assert.equal(calls.length, 0);
  }
});

test("a schema read with betas neither uses nor fills the schema cache", async () => {
  const ds = () => new Response(JSON.stringify({ object: "data_source", id: "x" }), { status: 200 });
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  let calls = 0;
  globalThis.fetch = async () => (calls++, ds());
  console.log = () => {};
  try {
    schemaCache.clear();
    const env = { NOTION_TOKEN: "t" };
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/x", betas: [STATUS] });
    assert.equal(schemaCache.size, 0, "beta response not cached");
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/x" });
    await notionRequest(env, { method: "GET", path: "/v1/data_sources/x", betas: [STATUS] });
    assert.equal(calls, 3, "beta read skips the cached plain response");
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    schemaCache.clear();
  }
});

test("Notion's missing-header error comes back with the betas argument to pass", async () => {
  const notionError = () =>
    new Response(
      JSON.stringify({
        object: "error",
        status: 400,
        code: "validation_error",
        message: `Status group operators require the "Notion-Beta: ${STATUS}" header.`,
      }),
      { status: 400 },
    );
  const { error } = await capture(
    { method: "POST", path: "/v1/data_sources/x/query", body: { filter: { property: "S", status: { group_equals: "Done" } } } },
    notionError,
  );
  assert.match(error.message, /validation_error/);
  assert.match(error.message, /betas: \["status-group-filters-2026-10-06"\]/);
});

test("each logged call says whether betas were sent, without logging other headers", async () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const logged = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ object: "list", results: [] }), { status: 200 });
  console.log = (x) => logged.push(x);
  try {
    await notionRequest({ NOTION_TOKEN: "t" }, { method: "POST", path: "/v1/data_sources/x/query", body: {}, betas: [STATUS] });
    await notionRequest({ NOTION_TOKEN: "t" }, { method: "POST", path: "/v1/data_sources/x/query", body: {} });
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  const lines = logged.filter((x) => x?.event === "notion_call");
  assert.deepEqual(lines[0].betas, [STATUS]);
  assert.equal("betas" in lines[1], false, "plain calls log exactly as before");
  assert.ok(!JSON.stringify(lines).includes("Bearer"));
});
