// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
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
