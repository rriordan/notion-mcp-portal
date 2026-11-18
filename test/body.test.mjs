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

// Regression test: an agent sent filter_properties in a data source query's body and Notion
// answered "400 validation_error: body.filter_properties should be not present". Notion only
// takes it in the query string, so the server moves it there.
import { hoistFilterProperties } from "../src/body.ts";

test("body.filter_properties is moved to the query string", () => {
  const req = { method: "POST", path: "/v1/data_sources/x/query", body: { page_size: 5, filter_properties: ["Entry", "Agent"] } };
  assert.deepEqual(hoistFilterProperties(req), {
    method: "POST",
    path: "/v1/data_sources/x/query",
    query: { filter_properties: ["Entry", "Agent"] },
    body: { page_size: 5 },
  });
});

test("moved filter_properties join ones already in the query, without duplicates", () => {
  const req = { method: "POST", path: "/v1/data_sources/x/query", query: { filter_properties: ["Entry"] }, body: { filter_properties: ["Entry", "Type"] } };
  assert.deepEqual(hoistFilterProperties(req).query, { filter_properties: ["Entry", "Type"] });
});

test("a single filter_properties string is moved too", () => {
  const req = { method: "POST", path: "/v1/data_sources/x/query", body: { filter_properties: "Entry" } };
  assert.deepEqual(hoistFilterProperties(req).query, { filter_properties: ["Entry"] });
});

test("a request without body.filter_properties is returned as is", () => {
  const req = { method: "POST", path: "/v1/data_sources/x/query", body: { page_size: 5 } };
  assert.equal(hoistFilterProperties(req), req);
  const noBody = { method: "GET", path: "/v1/pages/x" };
  assert.equal(hoistFilterProperties(noBody), noBody);
});
