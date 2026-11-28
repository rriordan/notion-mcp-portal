// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { notionRequest, READ_TIMEOUT_MS, timeoutFor, WRITE_TIMEOUT_MS } from "../src/notion.ts";
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
  await assert.rejects(fetchWithRetry(doFetch, { idempotent: false, sleep, timeoutMs: 20 }), /class=timeout.*may have landed.*Read it back/);
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
