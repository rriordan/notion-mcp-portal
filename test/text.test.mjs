// Run with: npm test
// Tool results are JSON without indentation, so more of a Notion response fits under the cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TEXT, text } from "../src/text.ts";

test("objects are returned as compact JSON", () => {
  assert.equal(text({ a: 1, b: [1, 2] }).content[0].text, '{"a":1,"b":[1,2]}');
});

test("strings are returned as they are", () => {
  assert.equal(text("hello").content[0].text, "hello");
});

test("long results are cut with a marker that gives the next offset", () => {
  const out = text("x".repeat(MAX_TEXT + 5)).content[0].text;
  assert.ok(out.startsWith("x".repeat(MAX_TEXT)));
  assert.match(out, new RegExp(`…\\[truncated: 5 more chars\\. Call again with the same arguments and offset=${MAX_TEXT}\\]$`));
});

test("offset returns the rest, with nothing lost or repeated", () => {
  const s = "a".repeat(MAX_TEXT) + "TAIL";
  const out = text(s, false, MAX_TEXT).content[0].text;
  assert.equal(out, `…[chars ${MAX_TEXT}–${MAX_TEXT + 4} of ${MAX_TEXT + 4}]\nTAIL`);
});

test("a cut write result doesn't offer an offset, which would repeat the write", () => {
  const out = text("x".repeat(MAX_TEXT + 5), false, 0, false).content[0].text;
  assert.doesNotMatch(out, /offset=/);
  assert.match(out, /don't repeat it/);
});

test("an offset past the end returns an empty slice, not an error", () => {
  assert.match(text("short", false, 99).content[0].text, /^…\[chars 5–5 of 5\]\n$/);
});

test("a long list keeps whole rows and stays valid JSON", () => {
  const row = { id: "r", text: "y".repeat(5000) };
  const list = { object: "list", results: Array(10).fill(row), next_cursor: "c1", has_more: true };
  const out = text(list).content[0].text;
  assert.ok(out.length <= MAX_TEXT);
  const parsed = JSON.parse(out);
  assert.equal(parsed.results.length + parsed.truncated_rows, 10);
  assert.ok(parsed.results.length >= 1);
  // Notion's cursor points past the left-out rows, so following it would skip them.
  assert.equal("next_cursor" in parsed, false);
  assert.equal(parsed.has_more, true);
  assert.match(parsed.hint, /same request/);
  assert.match(parsed.hint, /page_size=\d+/);
});

test("errors are flagged", () => {
  assert.equal(text("boom", true).isError, true);
  assert.equal("isError" in text("fine"), false);
});
