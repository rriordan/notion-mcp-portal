// Run with: npm test
// compactNotion trims Notion's response bloat while keeping every value a model needs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactNotion } from "../src/compact.ts";

const richText = (content, href = null) => ({
  type: "text",
  text: { content, link: href ? { url: href } : null },
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
  plain_text: content,
  href,
});

const page = {
  object: "page",
  id: "p1",
  created_by: { object: "user", id: "u1" },
  cover: null,
  icon: null,
  in_trash: false,
  is_archived: false,
  is_locked: false,
  public_url: null,
  url: "https://www.notion.so/p1",
  parent: { type: "data_source_id", data_source_id: "ds1" },
  properties: {
    Name: { id: "title", type: "title", title: [richText("Hello "), richText("world", "https://x.y")] },
    Status: { id: "a%3Fb", type: "select", select: { id: "s1", name: "To Process", color: "yellow" } },
    Tags: { id: "c", type: "multi_select", multi_select: [{ id: "t1", name: "AI", color: "red" }] },
    Done: { id: "d", type: "checkbox", checkbox: false },
    Due: { id: "e", type: "date", date: null },
    Links: { id: "f", type: "relation", relation: [], has_more: false },
    Owner: { id: "g", type: "people", people: [{ object: "user", id: "u2" }] },
  },
  request_id: "r1",
};

test("a page keeps its values and loses the bloat", () => {
  assert.deepEqual(compactNotion(page), {
    object: "page",
    id: "p1",
    created_by: "u1",
    url: "https://www.notion.so/p1",
    parent: { type: "data_source_id", data_source_id: "ds1" },
    properties: {
      Name: { type: "title", title: "Hello [world](https://x.y)" },
      Status: { type: "select", select: "To Process" },
      Tags: { type: "multi_select", multi_select: ["AI"] },
      Done: { type: "checkbox", checkbox: false },
      Due: { type: "date" },
      Links: { type: "relation", relation: [], has_more: false },
      Owner: { type: "people", people: ["u2"] },
    },
  });
});

test("true flags are kept", () => {
  assert.equal(compactNotion({ in_trash: true }).in_trash, true);
});

test("an empty rich-text array becomes an empty string", () => {
  assert.deepEqual(compactNotion({ type: "rich_text", rich_text: [] }), { type: "rich_text", rich_text: "" });
});

test("lists and scalars pass through", () => {
  assert.deepEqual(compactNotion({ object: "list", results: [page], has_more: false }).results[0].created_by, "u1");
  assert.equal(compactNotion("text"), "text");
});
