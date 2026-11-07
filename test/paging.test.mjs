// Run with: npm test
// A long list is re-fetched with a smaller page_size so its cursor skips nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchFitted, withPageSize } from "../src/paging.ts";
import { MAX_TEXT } from "../src/text.ts";

/** A fake Notion list: `total` rows of `width` chars each, paged by page_size from a numeric cursor. */
function fakeList(total, width) {
  const calls = [];
  const fetchPage = async (n) => {
    calls.push(n);
    const size = n ?? 100;
    const rows = Array.from({ length: Math.min(size, total) }, (_, i) => ({ id: `r${i}`, t: "y".repeat(width) }));
    const more = total > size;
    return { object: "list", results: rows, has_more: more, next_cursor: more ? `after-${size}` : null };
  };
  return { fetchPage, calls };
}
const shape = (d) => d;

test("a list that fits is returned as fetched, with one request", async () => {
  const { fetchPage, calls } = fakeList(150, 20);
  const out = await fetchFitted(fetchPage, shape);
  assert.equal(out.reissued, undefined);
  assert.deepEqual(calls, [undefined]);
  assert.equal(out.value.next_cursor, "after-100");
});

test("a list too long for one reply is re-fetched smaller and keeps a real cursor", async () => {
  const { fetchPage, calls } = fakeList(150, 1000);
  const out = await fetchFitted(fetchPage, shape);
  assert.ok(out.reissued && out.reissued < 100);
  assert.ok(JSON.stringify(out.value).length <= MAX_TEXT);
  // The cursor and the rows come from the same (second) response: they agree.
  assert.equal(out.value.next_cursor, `after-${out.reissued}`);
  assert.equal(out.value.results.length, out.reissued);
  assert.equal(out.value.has_more, true);
  assert.equal(out.value.truncated_rows, undefined);
  assert.match(out.value.note, /page_size lowered/);
  assert.equal(calls.length, 2);
});

test("a last page that is too long still gets a cursor, not a silent cut", async () => {
  const { fetchPage } = fakeList(40, 1000); // all 40 rows come back, has_more false
  const out = await fetchFitted(fetchPage, shape);
  assert.ok(out.reissued < 40);
  assert.equal(out.value.has_more, true);
  assert.ok(out.value.next_cursor);
});

test("rows bigger than the first page suggested shrink again", async () => {
  let calls = 0;
  // Rows get bigger the fewer you ask for, so the first estimate is too optimistic.
  const fetchPage = async (n) => {
    calls++;
    const size = n ?? 100;
    const width = n === undefined ? 400 : 700;
    return {
      results: Array.from({ length: size }, () => ({ t: "y".repeat(width) })),
      has_more: true,
      next_cursor: `c-${size}`,
    };
  };
  const out = await fetchFitted(fetchPage, shape);
  assert.ok(JSON.stringify(out.value).length <= MAX_TEXT);
  assert.ok(calls >= 3, `expected a second re-fetch, got ${calls} calls`);
});

test("when no page_size can be set, the first response comes back for text() to cut", async () => {
  const big = { results: Array(30).fill({ t: "y".repeat(1000) }), has_more: false };
  const out = await fetchFitted(async (n) => (n === undefined ? big : null), shape);
  assert.equal(out.value, big);
  assert.equal(out.reissued, undefined);
});

test("a single oversized row is left for text()", async () => {
  const one = { results: [{ t: "y".repeat(MAX_TEXT * 2) }], has_more: false };
  const { fetchPage, calls } = { fetchPage: async () => one, calls: [] };
  const out = await fetchFitted(fetchPage, shape);
  assert.equal(out.value, one);
});

test("withPageSize sets page_size in the body for POST and in the query for GET", () => {
  assert.deepEqual(withPageSize({ method: "POST", body: { filter: 1, page_size: 100 } }, 7).body, { filter: 1, page_size: 7 });
  assert.deepEqual(withPageSize({ method: "POST" }, 7).body, { page_size: 7 });
  assert.deepEqual(withPageSize({ method: "GET", query: { start_cursor: "c" } }, 7).query, { start_cursor: "c", page_size: 7 });
  assert.equal(withPageSize({ method: "PATCH", body: {} }, 7), null);
  assert.equal(withPageSize({ method: "POST", body: [1] }, 7), null);
});

test("starting from a page_size known to fit costs one request, and says it was lowered", async () => {
  const { fetchPage, calls } = fakeList(150, 1000);
  const out = await fetchFitted(fetchPage, shape, { startSize: 15 });
  assert.deepEqual(calls, [15]);
  assert.equal(out.fitted, 15);
  assert.equal(out.value.next_cursor, "after-15");
  assert.match(out.value.note, /page_size lowered to 15/);
});

test("a stale start size that is now too big is still corrected", async () => {
  const { fetchPage, calls } = fakeList(150, 1000);
  const out = await fetchFitted(fetchPage, shape, { startSize: 60 });
  assert.ok(out.reissued < 60);
  assert.equal(calls.length, 2);
  assert.ok(JSON.stringify(out.value).length <= MAX_TEXT);
});

test("a remembered page_size that fills the cap to the last chars is not pushed over it by the note", async () => {
  // Rows total just under the cap: adding page_size_reduced_to + note would exceed it.
  let width = 2000;
  const make = (w) => ({ object: "list", results: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, t: "y".repeat(w) })), has_more: true, next_cursor: "c" });
  while (JSON.stringify(make(width)).length < MAX_TEXT - 60) width += 1;
  while (JSON.stringify(make(width)).length > MAX_TEXT - 40) width -= 1;
  const bare = JSON.stringify(make(width)).length;
  assert.ok(bare <= MAX_TEXT && bare > MAX_TEXT - 100);
  const calls = [];
  const out = await fetchFitted(async (n) => (calls.push(n), make(width)), shape, { startSize: 10 });
  assert.deepEqual(calls, [10]);
  assert.ok(JSON.stringify(out.value).length <= MAX_TEXT, "annotated reply must still fit");
  assert.equal(out.value.next_cursor, "c");
  assert.equal(out.value.results.length, 10);
});
