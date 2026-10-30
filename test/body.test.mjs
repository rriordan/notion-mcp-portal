// Run with: npm test
// Regression test: claude.ai sent notion_request's body as a JSON string, the server
// encoded it again, and Notion answered "400 invalid_json: Error parsing JSON body".
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBody } from "../src/body.ts";

test("a JSON string body becomes the object Notion expects", () => {
  assert.deepEqual(parseBody('{"page_size":50}'), { page_size: 50 });
});

test("a body encoded as JSON twice is unwrapped to the object", () => {
  assert.deepEqual(parseBody(JSON.stringify('{"page_size":50}')), { page_size: 50 });
});

test("an object body is passed through unchanged", () => {
  const body = { filter: { property: "Status", select: { equals: "To Process" } } };
  assert.equal(parseBody(body), body);
});

test("no body stays undefined", () => {
  assert.equal(parseBody(undefined), undefined);
});

test("a string that isn't JSON is rejected with a clear message", () => {
  assert.throws(() => parseBody("not json"), /body must be a JSON object/);
});
