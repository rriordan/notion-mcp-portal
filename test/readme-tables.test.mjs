// README table parser: stores and guides are resolved from the README's own tables.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findTable, resolveGuide, resolveStore } from "../src/readme-tables.ts";
import { AL_ID, GUIDE_ID, PREFS_ID, README_MD } from "./fixtures/readme.ts";

test("findTable finds by heading, not position", () => {
  assert.ok(findTable(README_MD, "Guides").headers.includes("Guide"));
  assert.deepEqual(findTable(README_MD, "Where things go").headers, ["What", "Where", "Data source", "Notes"]);
  assert.equal(findTable(README_MD, "Nope"), null);
});

test("resolveStore returns the data source id", () => {
  assert.deepEqual(resolveStore(README_MD, "Activity Log"), { ok: true, value: AL_ID });
  assert.deepEqual(resolveStore(README_MD, "Preferences"), { ok: true, value: PREFS_ID });
});

test("resolveGuide returns the page id", () => {
  const r = resolveGuide(README_MD, "Tool Guide");
  assert.equal(r.ok, true);
  assert.match(r.value, /^[0-9a-f]{32}$/);
  assert.equal(r.value, GUIDE_ID);
});

test("columns are found by header text", () => {
  // Swap the "Where" and "Data source" columns in every row of the store table.
  const md = README_MD.replace(/(<tr>\n<td>[^\n]*<\/td>\n)(<td>[^\n]*<\/td>\n)(<td>[^\n]*<\/td>\n)/g, "$1$3$2");
  assert.notEqual(md, README_MD);
  assert.deepEqual(findTable(md, "Where things go").headers, ["What", "Data source", "Where", "Notes"]);
  assert.deepEqual(resolveStore(md, "Activity Log"), { ok: true, value: AL_ID });
  assert.deepEqual(resolveStore(md, "Preferences"), { ok: true, value: PREFS_ID });
});

test("name matching ignores case, spaces and emphasis", () => {
  assert.deepEqual(resolveStore(README_MD, "  activity   log "), { ok: true, value: AL_ID });
  const md = README_MD.replace("[Activity Log](", "[**Activity  Log**](");
  assert.deepEqual(resolveStore(md, "Activity Log"), { ok: true, value: AL_ID });
  assert.equal(resolveGuide(README_MD, "tool guide").value, GUIDE_ID);
});

test("unknown name lists the valid names", () => {
  const r = resolveStore(README_MD, "Nope");
  assert.equal(r.ok, false);
  assert.match(r.error, /Activity Log/);
  assert.match(r.error, /Preferences/);
  const g = resolveGuide(README_MD, "Nope");
  assert.equal(g.ok, false);
  assert.match(g.error, /Tool Guide/);
});

test("missing heading or column is named", () => {
  const noGuides = README_MD.replace("## Guides", "## Other");
  const g = resolveGuide(noGuides, "Tool Guide");
  assert.equal(g.ok, false);
  assert.match(g.error, /## Guides/);
  const noCol = README_MD.replace("<td>Data source</td>", "<td>Source</td>");
  const s = resolveStore(noCol, "Activity Log");
  assert.equal(s.ok, false);
  assert.match(s.error, /Data source/);
});

test("duplicate names are ambiguous", () => {
  const row = README_MD.match(/<tr>\n<td>A record of agent work<\/td>[\s\S]*?<\/tr>\n/)[0];
  const md = README_MD.replace(row, row + row.replace(AL_ID, "55555555-5555-5555-5555-555555555555"));
  const r = resolveStore(md, "Activity Log");
  assert.equal(r.ok, false);
  assert.match(r.error, /ambiguous/);
});
