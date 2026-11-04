// Run with: npm test
// format "values" turns rows into { id, url, last_edited_time, props } with computed values.
import assert from "node:assert/strict";
import { test } from "node:test";
import { propertyValue, valuesNotion } from "../src/values.ts";
import { shape } from "../src/shape.ts";

const rt = (s) => [{ type: "text", plain_text: s, href: null, annotations: {} }];

// Shapes taken from a real data source query (API version 2025-09-03).
const page = {
  object: "page",
  id: "p1",
  created_time: "2026-11-02T20:25:00.000Z",
  last_edited_time: "2026-11-02T23:57:00.000Z",
  created_by: { object: "user", id: "u1" },
  parent: { type: "data_source_id", data_source_id: "ds1", database_id: "db1" },
  in_trash: false,
  url: "https://app.notion.com/p/p1",
  properties: {
    Task: { id: "title", type: "title", title: rt("Investigate context window") },
    Attention: { id: "a", type: "select", select: null },
    Effort: { id: "b", type: "number", number: 2 },
    Done: { id: "c", type: "checkbox", checkbox: false },
    Due: { id: "d", type: "date", date: null },
    Notes: { id: "e", type: "rich_text", rich_text: [] },
    Tags: { id: "f", type: "multi_select", multi_select: [{ id: "t", name: "AI", color: "red" }] },
    Project: { id: "g", type: "relation", relation: [{ id: "proj1" }], has_more: false },
    Urgency: { id: "h", type: "formula", formula: { type: "string", string: "No deadline" } },
    Rank: { id: "i", type: "formula", formula: { type: "number", number: 6 } },
    Area: {
      id: "j",
      type: "rollup",
      rollup: { type: "array", function: "show_original", array: [{ type: "relation", relation: [{ id: "area1" }] }] },
    },
    Empty: { id: "k", type: "rollup", rollup: { type: "array", function: "show_original", array: [{ type: "relation", relation: [] }] } },
    Window: { id: "l", type: "date", date: { start: "2026-11-01", end: "2026-11-03" } },
    Source: { id: "m", type: "url", url: "https://example.com" },
  },
};

test("a page keeps only filled values, under their property names", () => {
  assert.deepEqual(valuesNotion(page), {
    id: "p1",
    url: "https://app.notion.com/p/p1",
    last_edited_time: "2026-11-02T23:57:00.000Z",
    props: {
      Task: "Investigate context window",
      Effort: 2,
      Done: false,
      Tags: ["AI"],
      Project: ["proj1"],
      Urgency: "No deadline",
      Rank: 6,
      Area: ["area1"],
      Window: "2026-11-01/2026-11-03",
      Source: "https://example.com",
    },
  });
});

test("a list keeps its cursor and drops the rest of the envelope", () => {
  const list = { object: "list", results: [page], next_cursor: "s:1", has_more: true, type: "page_or_data_source", page_or_data_source: {} };
  const out = valuesNotion(list);
  assert.deepEqual(Object.keys(out), ["results", "has_more", "next_cursor"]);
  assert.equal(out.results[0].props.Rank, 6);
});

test("values is much smaller than compact for the same rows", async () => {
  const { compactNotion } = await import("../src/compact.ts");
  const list = { object: "list", results: Array(20).fill(page), has_more: false };
  const v = JSON.stringify(valuesNotion(list)).length;
  const c = JSON.stringify(compactNotion(list)).length;
  assert.ok(v < c * 0.6, `values ${v} vs compact ${c}`);
});

test("non-page responses fall back to compact", () => {
  assert.deepEqual(valuesNotion({ object: "user", id: "u1", name: "Bot", avatar_url: null }), {
    object: "user",
    id: "u1",
    name: "Bot",
  });
});

test("unknown property types pass through their value", () => {
  assert.equal(propertyValue({ type: "email", email: "a@b.c" }), "a@b.c");
  assert.equal(propertyValue({ type: "unique_id", unique_id: { prefix: "T", number: 4 } }), "T-4");
});

test("page markdown comes back as plain Markdown, with Notion's flags kept", () => {
  assert.equal(shape("GET", "/v1/pages/p1/markdown", { object: "page_markdown", id: "p1", markdown: "# Hi\nthere" }), "# Hi\nthere");
  const flagged = shape("GET", "/v1/pages/p1/markdown", {
    object: "page_markdown",
    markdown: "# Hi",
    truncated: true,
    unknown_block_ids: ["b1"],
  });
  assert.match(flagged, /^# Hi\n\n…\[Notion marked this page truncated\. Blocks not rendered: b1/);
  assert.equal(shape("GET", "/v1/pages/p1/markdown", { object: "page_markdown", markdown: "x" }, "raw").markdown, "x");
});
