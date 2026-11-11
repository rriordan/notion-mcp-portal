// bench: the "Saved" column compares like with like when the two formats returned different row counts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rowCount, savedCell } from "../bench/saved.mjs";

test("rowCount reads a list's rows, and null for anything else", () => {
  assert.equal(rowCount(JSON.stringify({ results: [1, 2, 3] })), 3);
  assert.equal(rowCount(JSON.stringify({ id: "x" })), null);
  assert.equal(rowCount("…[chars 10–20 of 30]\nnot json"), null);
});

test("same rows (or no rows): saved is the plain size ratio", () => {
  assert.equal(savedCell({ size: 1000, rows: 10 }, { size: 600, rows: 10 }), "40%");
  assert.equal(savedCell({ size: 1000, rows: null }, { size: 560, rows: null }), "44%");
});

test("different row counts: saved is per row, and says so", () => {
  // Both replies hit the cap; compact fitted 10 rows where raw fitted 6.
  assert.equal(savedCell({ size: 6000, rows: 6 }, { size: 6300, rows: 10 }), "37% per row (6 vs 10 rows)");
});

test("a raw result cut mid-text can't be compared", () => {
  assert.equal(savedCell({ size: 6000, rows: null, truncated: true }, { size: 3000, rows: null }), "n/a (raw truncated)");
});
