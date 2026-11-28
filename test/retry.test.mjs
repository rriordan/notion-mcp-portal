// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { notionRequest, READ_TIMEOUT_MS, responseText, SCHEMA_TTL_MS, schemaCache, timedFetch, timeoutFor, WRITE_TIMEOUT_MS } from "../src/notion.ts";
import { classify, errorTag, fetchWithRetry, MAX_RETRIES, retryAfterSeconds } from "../src/retry.ts";

const res = (status, headers = {}) => new Response("{}", { status, headers });
/** doFetch that plays back `steps` (a Response or an Error each), and counts calls. */
function script(...steps) {
  const state = { calls: 0 };
  state.doFetch = async () => {
    const step = steps[Math.min(state.calls++, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return state;
}
const waits = [];
const sleep = async (ms) => void waits.push(ms);

test("429 waits for Retry-After and tries again, for a write too (Notion refused it unrun)", async () => {
  waits.length = 0;
  const s = script(res(429, { "Retry-After": "3" }), res(200));
  const out = await fetchWithRetry(s.doFetch, { idempotent: false, sleep });
  assert.equal(out.res.status, 200);
  assert.equal(out.retries, 1);
  assert.deepEqual(waits, [3000]);
});

test("a very long Retry-After is capped", () => {
  assert.equal(retryAfterSeconds("120"), 10);
  assert.equal(retryAfterSeconds(null), 1);
  assert.equal(retryAfterSeconds("abc"), 1);
});

test("429 gives up after MAX_RETRIES and returns the 429", async () => {
  const s = script(res(429, { "Retry-After": "1" }));
  const out = await fetchWithRetry(s.doFetch, { idempotent: true, sleep });
  assert.equal(out.res.status, 429);
  assert.equal(s.calls, MAX_RETRIES + 1);
});

test("a read is retried on 503; a write is not (it may have run)", async () => {
  const read = script(res(503), res(200));
  assert.equal((await fetchWithRetry(read.doFetch, { idempotent: true, sleep })).res.status, 200);
  const write = script(res(503), res(200));
  assert.equal((await fetchWithRetry(write.doFetch, { idempotent: false, sleep })).res.status, 503);
  assert.equal(write.calls, 1);
});

test("a network failure is retried for a read and reported, not re-sent, for a write", async () => {
  const read = script(new Error("boom"), res(200));
  assert.equal((await fetchWithRetry(read.doFetch, { idempotent: true, sleep })).res.status, 200);
  const write = script(new Error("boom"), res(200));
  await assert.rejects(fetchWithRetry(write.doFetch, { idempotent: false, sleep }), /class=network.*not repeated.*read it back/);
  assert.equal(write.calls, 1);
});

test("a 4xx other than 429 is returned at once", async () => {
  const s = script(res(404));
  assert.equal((await fetchWithRetry(s.doFetch, { idempotent: true, sleep })).retries, 0);
  assert.equal(s.calls, 1);
});

/** A doFetch that never replies on its own: it rejects with the signal's reason once it aborts. */
const hang = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

test("a read that times out is retried once, then fails with class=timeout", async () => {
  let calls = 0;
  const doFetch = (signal) => (calls++, hang(signal));
  await assert.rejects(fetchWithRetry(doFetch, { idempotent: true, sleep, timeoutMs: 20 }), (e) => {
    assert.match(e.message, /timeout: no reply in 0\.02 s, tried twice \[class=timeout; retryable later\]/);
    assert.equal(e.cls, "timeout");
    return true;
  });
  assert.equal(calls, 2);
});

test("a write that times out is not re-sent and says it may have landed", async () => {
  let calls = 0;
  const doFetch = (signal) => (calls++, hang(signal));
  await assert.rejects(fetchWithRetry(doFetch, { idempotent: false, sleep, timeoutMs: 20 }), (e) => {
    assert.match(e.message, /class=timeout.*may have landed.*may still land after a delay/);
    assert.match(e.message, /stable identifier \(for a create, query for a unique property value\)/);
    assert.match(e.message, /don't resend just because a first read-back shows nothing/);
    return true;
  });
  assert.equal(calls, 1);
});

test("an attempt that ignores the signal still times out", async () => {
  let calls = 0;
  const doFetch = () => (calls++, new Promise(() => {}));
  await assert.rejects(fetchWithRetry(doFetch, { idempotent: true, sleep, timeoutMs: 20 }), /class=timeout/);
  assert.equal(calls, 2);
});

test("timeouts don't use up the network-failure retries", async () => {
  // One timeout, then MAX_RETRIES network errors, then success: all within budget.
  let calls = 0;
  const doFetch = (signal) => {
    calls++;
    if (calls === 1) return hang(signal);
    if (calls <= 1 + MAX_RETRIES) return Promise.reject(new Error("boom"));
    return Promise.resolve(res(200));
  };
  const out = await fetchWithRetry(doFetch, { idempotent: true, sleep, timeoutMs: 20 });
  assert.equal(out.res.status, 200);
  assert.equal(calls, MAX_RETRIES + 2);
  assert.equal(out.retries, MAX_RETRIES + 1);
});

test("a stalled body counts as the same attempt: retried for a read, logged as a timeout", async () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const lines = [];
  let calls = 0;
  // Headers arrive at once; the body never ends.
  globalThis.fetch = async () => (calls++, new Response(new ReadableStream({ start() {} }), { status: 200 }));
  console.log = (x) => lines.push(x);
  try {
    await assert.rejects(
      notionRequest({ NOTION_TOKEN: "t", NOTION_TIMEOUT_MS: "20" }, { method: "GET", path: "/v1/pages/stall" }),
      /class=timeout; retryable later/,
    );
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert.equal(calls, 2);
  const logged = lines.filter((l) => l?.event === "notion_call");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].error, "timeout");
  assert.equal(logged[0].status, 0);
});

/** Headers at once, a body that never ends. */
const stalled = (status, headers = {}) => new Response(new ReadableStream({ start() {} }), { status, headers });

/** Swap globalThis.fetch (and capture notion_call log lines) for the length of `fn`. */
async function withFetch(fake, fn) {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const lines = [];
  globalThis.fetch = fake;
  console.log = (x) => lines.push(x);
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  return lines.filter((l) => l?.event === "notion_call");
}

test("a 429 whose body stalls is retried as a 429 for a write, not reported as a timeout", async () => {
  waits.length = 0;
  let calls = 0;
  const url = new URL("https://api.notion.com/v1/pages");
  await withFetch(
    async () => (++calls === 1 ? stalled(429, { "Retry-After": "0" }) : new Response('{"ok":true}', { status: 200 })),
    async () => {
      const out = await fetchWithRetry(timedFetch(url, { method: "POST" }, 40), { idempotent: false, sleep, timeoutMs: 40 });
      assert.equal(out.res.status, 200);
      assert.equal(out.retries, 1);
      assert.deepEqual(JSON.parse(await responseText(out.res)), { ok: true });
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000], "slept per Retry-After (0 falls back to 1 s), not a timeout");
});

test("a 503 whose body stalls is retried for a read and surfaces as upstream for a write", async () => {
  const url = new URL("https://api.notion.com/v1/pages/p");
  let calls = 0;
  await withFetch(
    async () => (++calls === 1 ? stalled(503) : new Response("{}", { status: 200 })),
    async () => {
      const out = await fetchWithRetry(timedFetch(url, { method: "GET" }, 40), { idempotent: true, sleep, timeoutMs: 40 });
      assert.equal(out.res.status, 200);
      assert.equal(out.retries, 1);
    },
  );
  assert.equal(calls, 2);
  // Through notionRequest: a write is not re-sent, and the error is the 503, not a timeout.
  calls = 0;
  const logged = await withFetch(
    async () => (calls++, stalled(503)),
    () =>
      assert.rejects(
        notionRequest({ NOTION_TOKEN: "t", NOTION_TIMEOUT_MS: "20" }, { method: "POST", path: "/v1/pages", body: {} }),
        (e) => {
          assert.match(e.message, /^Notion API 503/);
          assert.match(e.message, /class=upstream; not repeated/);
          assert.doesNotMatch(e.message, /timeout/);
          return true;
        },
      ),
  );
  assert.equal(calls, 1);
  assert.equal(logged[0].status, 503);
  assert.equal(logged[0].error, undefined);
});

test("a schema write that times out keeps the schema cache off for SCHEMA_TTL_MS", async () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const env = { NOTION_TOKEN: "t", NOTION_TIMEOUT_MS: "20" };
  const get = () => notionRequest(env, { method: "GET", path: "/v1/data_sources/ds" });
  let schema = "old";
  let gets = 0;
  schemaCache.clear();
  try {
    const logged = await withFetch(
      (u, init) => {
        if (init.method === "PATCH") return hang(init.signal); // Notion never answers
        gets++;
        return Promise.resolve(new Response(JSON.stringify({ id: "ds", v: schema }), { status: 200 }));
      },
      async () => {
        await assert.rejects(
          notionRequest(env, { method: "PATCH", path: "/v1/data_sources/ds", body: { properties: { Tag: { select: {} } } } }),
          /class=timeout.*may have landed/,
        );
        assert.equal((await get()).v, "old"); // read back before Notion commits
        schema = "new"; // the write lands late
        assert.equal((await get()).v, "new", "fetched live, not the cached old schema");
        assert.equal(gets, 2);
        assert.equal(schemaCache.size, 0);
        now += SCHEMA_TTL_MS + 1; // window over: caching resumes
        assert.equal((await get()).v, "new");
        assert.equal((await get()).v, "new");
        assert.equal(gets, 3, "the last read was a cache hit");
      },
    );
    assert.deepEqual(
      logged.filter((l) => l.method === "GET").map((l) => l.cache),
      ["suspect", "suspect", "miss", "hit"],
    );
  } finally {
    Date.now = realNow;
    schemaCache.clear();
  }
});

test("a 429 whose body fails mid-way is retried as a 429 for a write, not a network error", async () => {
  waits.length = 0;
  let calls = 0;
  const url = new URL("https://api.notion.com/v1/pages");
  const broken = () => {
    let pulls = 0;
    const body = new ReadableStream({
      pull(c) {
        if (pulls++ === 0) c.enqueue(new TextEncoder().encode('{"code":"rate_'));
        else c.error(new Error("connection reset"));
      },
    });
    return new Response(body, { status: 429, headers: { "Retry-After": "0" } });
  };
  await withFetch(
    async () => (++calls === 1 ? broken() : new Response('{"ok":true}', { status: 200 })),
    async () => {
      const out = await fetchWithRetry(timedFetch(url, { method: "POST" }, 40), { idempotent: false, sleep, timeoutMs: 40 });
      assert.equal(out.res.status, 200);
      assert.equal(out.retries, 1);
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000], "slept per Retry-After, not reported as network or timeout");
});

test("a noCache read in the suspect window doesn't store the old schema past the window", async () => {
  const realNow = Date.now;
  let now = 5_000_000;
  Date.now = () => now;
  const env = { NOTION_TOKEN: "t", NOTION_TIMEOUT_MS: "20" };
  let schema = "old";
  schemaCache.clear();
  try {
    const logged = await withFetch(
      (u, init) => {
        if (init.method === "PATCH") return hang(init.signal);
        return Promise.resolve(new Response(JSON.stringify({ id: "ds", v: schema }), { status: 200 }));
      },
      async () => {
        await assert.rejects(
          notionRequest(env, { method: "PATCH", path: "/v1/data_sources/ds", body: { properties: { Tag: { select: {} } } } }),
          /class=timeout/,
        );
        now += SCHEMA_TTL_MS - 10; // late in the window, so a stored entry would outlive it
        const fresh = await notionRequest(env, { method: "GET", path: "/v1/data_sources/ds", noCache: true });
        assert.equal(fresh.v, "old");
        assert.equal(schemaCache.size, 0, "the noCache read stored nothing");
        schema = "new"; // the write lands late
        now += 11; // window over
        assert.equal((await notionRequest(env, { method: "GET", path: "/v1/data_sources/ds" })).v, "new");
      },
    );
    assert.deepEqual(
      logged.filter((l) => l.method === "GET").map((l) => l.cache),
      ["bypass", "miss"],
    );
  } finally {
    Date.now = realNow;
    schemaCache.clear();
  }
});

test("a 503 body that never finishes is cancelled once the cap expires", async () => {
  let cancelled = 0;
  const body = new ReadableStream({ start() {}, cancel: () => void cancelled++ });
  const url = new URL("https://api.notion.com/v1/pages/p");
  await withFetch(
    async () => new Response(body, { status: 503, headers: { "Retry-After": "2" } }),
    async () => {
      const r = await timedFetch(url, { method: "GET" }, 40)(new AbortController().signal);
      assert.equal(r.status, 503);
      assert.equal(r.headers.get("Retry-After"), "2");
      assert.equal(await r.text(), "");
    },
  );
  assert.equal(cancelled, 1, "the abandoned body was cancelled");
});

test("a non-2xx reply with no body still works", async () => {
  const url = new URL("https://api.notion.com/v1/pages/p");
  await withFetch(
    async () => new Response(null, { status: 502 }),
    async () => {
      const r = await timedFetch(url, { method: "GET" }, 40)(new AbortController().signal);
      assert.equal(r.status, 502);
      assert.equal(await r.text(), "");
    },
  );
});

test("a 429 whose headers arrive just before the deadline is retried as a 429, not a timeout", async () => {
  // Frozen Date.now makes timedFetch think the whole attempt is left, so its error-body cap
  // (20 ms) outlasts the attempt timer (40 ms, headers at ~30 ms): the deadline comes mid-body.
  waits.length = 0;
  const realNow = Date.now;
  Date.now = () => 7_000_000;
  let calls = 0;
  const url = new URL("https://api.notion.com/v1/pages");
  try {
    await withFetch(
      async () => {
        if (++calls > 1) return new Response('{"ok":true}', { status: 200 });
        await new Promise((r) => setTimeout(r, 30));
        return stalled(429, { "Retry-After": "0" });
      },
      async () => {
        const out = await fetchWithRetry(timedFetch(url, { method: "POST" }, 40), { idempotent: false, sleep, timeoutMs: 40 });
        assert.equal(out.res.status, 200);
        assert.equal(out.retries, 1);
      },
    );
  } finally {
    Date.now = realNow;
  }
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000], "slept per Retry-After, not a timeout");
});

test("a body is decoded once: timedFetch returns headers only and carries the text", async () => {
  const url = new URL("https://api.notion.com/v1/pages/p");
  await withFetch(
    async () => new Response('{"id":"p"}', { status: 200 }),
    async () => {
      const r = await timedFetch(url, { method: "GET" }, 40)(new AbortController().signal);
      assert.equal(r.body, null, "no second copy of the body");
      assert.equal(await responseText(r), '{"id":"p"}');
    },
  );
  await withFetch(
    async () => new Response('{"code":"validation_error","message":"bad"}', { status: 404 }),
    async () => {
      const r = await timedFetch(url, { method: "GET" }, 40)(new AbortController().signal);
      assert.equal(r.body, null);
      assert.equal(await responseText(r), '{"code":"validation_error","message":"bad"}');
    },
  );
  // A Response timedFetch didn't make falls back to its own body.
  assert.equal(await responseText(new Response("plain")), "plain");
  // Through notionRequest: the 2xx data and the error body both arrive parsed.
  const env = { NOTION_TOKEN: "t" };
  await withFetch(
    async () => new Response('{"id":"p","ok":true}', { status: 200 }),
    async () => assert.deepEqual(await notionRequest(env, { method: "GET", path: "/v1/pages/p" }), { id: "p", ok: true }),
  );
  await withFetch(
    async () => new Response('{"code":"object_not_found","message":"no such page"}', { status: 404 }),
    () => assert.rejects(notionRequest(env, { method: "GET", path: "/v1/pages/p" }), /^Error: Notion API 404 object_not_found: no such page \[class=not_found/),
  );
});

test("timeouts: reads 10 s, writes 30 s; NOTION_TIMEOUT_MS scales both", () => {
  assert.equal(timeoutFor({}, true), READ_TIMEOUT_MS);
  assert.equal(timeoutFor({}, false), WRITE_TIMEOUT_MS);
  assert.equal(READ_TIMEOUT_MS, 10_000);
  assert.equal(WRITE_TIMEOUT_MS, 30_000);
  assert.equal(timeoutFor({ NOTION_TIMEOUT_MS: "300" }, true), 300);
  assert.equal(timeoutFor({ NOTION_TIMEOUT_MS: "300" }, false), 900);
  assert.equal(timeoutFor({ NOTION_TIMEOUT_MS: "nope" }, true), READ_TIMEOUT_MS);
});

test("errors are classed so a caller can tell partial, rate-limit, quota and auth failures apart", () => {
  assert.equal(classify(429, "rate_limited").cls, "rate_limited");
  assert.equal(classify(429, "usage_limit_reached").cls, "quota");
  assert.equal(classify(429, "usage_limit_reached").retryable, false);
  assert.equal(classify(401).cls, "unauthorized");
  assert.equal(classify(403).cls, "forbidden");
  assert.equal(classify(404).cls, "not_found");
  assert.equal(classify(503).cls, "upstream");
  assert.match(errorTag(429, "rate_limited", "4", true), /class=rate_limited; retryable; retry_after=4s/);
  assert.match(errorTag(503, undefined, null, false), /not repeated: this request changes Notion/);
  assert.match(errorTag(401, "unauthorized", null, true), /not retryable/);
});
