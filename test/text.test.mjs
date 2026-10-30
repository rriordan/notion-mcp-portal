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

test("long results are truncated with a marker", () => {
  const out = text("x".repeat(MAX_TEXT + 5)).content[0].text;
  assert.ok(out.startsWith("x".repeat(MAX_TEXT)));
  assert.match(out, /…\[truncated 5 chars\]$/);
});

test("errors are flagged", () => {
  assert.equal(text("boom", true).isError, true);
  assert.equal("isError" in text("fine"), false);
});
