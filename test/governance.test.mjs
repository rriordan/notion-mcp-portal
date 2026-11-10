// governance_bundle pieces: compact field lists, Scope options, the Preferences query.
import assert from "node:assert/strict";
import { test } from "node:test";
import { preferencesRequest, scopeOptions } from "../src/governance.ts";
import { compactFields } from "../src/shape.ts";
import { AL_DS, PREFS_DS } from "./fixtures/datasources.ts";
import { AL_ID, PREFS_ID } from "./fixtures/readme.ts";

test("compactFields keeps name, type, options, description", () => {
  assert.deepEqual(compactFields(AL_DS), {
    data_source_id: AL_ID,
    fields: [
      { name: "Result", type: "select", options: ["Success", "Failed"] },
      { name: "Summary", type: "rich_text", description: "One line, past tense." },
      { name: "Task", type: "title" },
    ],
  });
});

test("scopeOptions reads the Scope options", () => {
  assert.deepEqual(scopeOptions(PREFS_DS), ["Whole workspace", "Team A"]);
  const { Scope, ...rest } = PREFS_DS.properties;
  assert.equal(scopeOptions({ ...PREFS_DS, properties: rest }), null);
});

test("preferencesRequest with and without scope", () => {
  const adopted = { property: "Status", select: { equals: "Adopted" } };
  const whole = { property: "Scope", multi_select: { contains: "Whole workspace" } };
  const team = { property: "Scope", multi_select: { contains: "Team A" } };

  const withScope = preferencesRequest(PREFS_ID, "Team A");
  assert.equal(withScope.method, "POST");
  assert.equal(withScope.path, `/v1/data_sources/${PREFS_ID}/query`);
  assert.deepEqual(withScope.query, { filter_properties: ["Preference", "Strength", "Scope"] });
  assert.equal(withScope.noCache, true);
  assert.deepEqual(withScope.body, { page_size: 100, filter: { and: [adopted, { or: [team, whole] }] } });

  const noScope = preferencesRequest(PREFS_ID, null, "c2");
  assert.deepEqual(noScope.body, { page_size: 100, start_cursor: "c2", filter: { and: [adopted, whole] } });
  assert.equal(noScope.noCache, true);
});

// ---------------------------------------------------------------------------
// buildBundle, against a fake Notion keyed on "METHOD path"
// ---------------------------------------------------------------------------
import { buildBundle } from "../src/governance.ts";
import { GUIDE_ID, README_MD } from "./fixtures/readme.ts";

const page = (pref, strength, scopes) => ({
  object: "page",
  id: `p-${pref}`,
  properties: {
    Preference: { type: "title", title: [{ type: "text", plain_text: pref }] },
    Strength: { type: "select", select: { name: strength } },
    Scope: { type: "multi_select", multi_select: scopes.map((name) => ({ name })) },
  },
});

function fakeNotion(overrides = {}) {
  const calls = [];
  const routes = {
    "GET /v1/pages/readme/markdown": { object: "page_markdown", markdown: README_MD, truncated: false, unknown_block_ids: [] },
    [`GET /v1/data_sources/${AL_ID}`]: AL_DS,
    [`GET /v1/data_sources/${PREFS_ID}`]: PREFS_DS,
    [`POST /v1/data_sources/${PREFS_ID}/query`]: {
      object: "list",
      results: [page("Be brief", "Guardrail", ["Whole workspace"])],
      has_more: false,
      next_cursor: null,
    },
    [`GET /v1/pages/${GUIDE_ID}/markdown`]: { object: "page_markdown", markdown: "# Tool Guide", truncated: false },
    ...overrides,
  };
  const request = async (r) => {
    calls.push(r);
    const route = routes[`${r.method} ${r.path}`];
    if (route === undefined) throw new Error(`Notion API 404 object_not_found: ${r.path}`);
    return typeof route === "function" ? route(r) : route;
  };
  return { calls, request };
}

test("clean bundle", async () => {
  const { calls, request } = fakeNotion();
  const b = await buildBundle("readme", { scope: "Team A" }, request);
  assert.deepEqual(b.errors, []);
  assert.equal(Object.keys(b)[0], "errors");
  assert.equal(b.readme.id, "readme");
  assert.match(b.readme.markdown, /## Where things go/);
  assert.equal(b.activity_log_fields.data_source_id, AL_ID);
  assert.ok(b.activity_log_fields.fields.some((f) => f.description));
  assert.equal(b.preferences.scope, "Team A");
  assert.deepEqual(b.preferences.rows[0], { Preference: "Be brief", Strength: "Guardrail", Scope: ["Whole workspace"] });
  assert.ok(!("Evidence" in b.preferences.rows[0]));
  assert.ok(!("schemas" in b) && !("guides" in b));
  assert.ok(calls.length >= 4);
  assert.ok(calls.every((r) => r.noCache === true));
});

test("no scope means Whole workspace only", async () => {
  const { calls, request } = fakeNotion();
  const b = await buildBundle("readme", {}, request);
  assert.equal(b.preferences.scope, null);
  const q = calls.find((r) => r.method === "POST");
  assert.deepEqual(q.body.filter.and[1], { property: "Scope", multi_select: { contains: "Whole workspace" } });
});

test("unknown scope errors with the options", async () => {
  const { request } = fakeNotion();
  const b = await buildBundle("readme", { scope: "Nope" }, request);
  assert.equal(b.preferences, null);
  const e = b.errors.find((x) => x.section === "preferences");
  assert.match(e.message, /Nope/);
  assert.match(e.message, /Team A/);
  assert.ok(b.readme.markdown);
  assert.ok(b.activity_log_fields.fields.length);
});

test("unknown guide or schema errors by name", async () => {
  const { request } = fakeNotion();
  const b = await buildBundle("readme", { guides: ["Nope", "Tool Guide"], schemas: ["Nada", "Preferences"] }, request);
  assert.equal(b.guides.Nope, null);
  assert.deepEqual(b.guides["Tool Guide"], { id: GUIDE_ID, markdown: "# Tool Guide" });
  assert.equal(b.schemas.Nada, null);
  assert.equal(b.schemas.Preferences.data_source_id, PREFS_ID);
  assert.ok(b.errors.some((x) => x.section === "guides.Nope" && /Nope/.test(x.message) && /Tool Guide/.test(x.message)));
  assert.ok(b.errors.some((x) => x.section === "schemas.Nada" && /Nada/.test(x.message)));
  assert.equal(b.errors.length, 2);
});

test("wave-2 failure is isolated", async () => {
  const { request } = fakeNotion({
    [`GET /v1/data_sources/${AL_ID}`]: () => {
      throw new Error("Notion API 404 object_not_found: gone");
    },
  });
  const b = await buildBundle("readme", {}, request);
  assert.equal(b.activity_log_fields, null);
  assert.match(b.errors.find((x) => x.section === "activity_log_fields").message, /Notion API 404/);
  assert.equal(b.preferences.rows.length, 1);
});

test("truncated README is reported as truncated", async () => {
  const cut = README_MD.slice(0, README_MD.indexOf("## Guides"));
  const { request } = fakeNotion({
    "GET /v1/pages/readme/markdown": { object: "page_markdown", markdown: cut, truncated: true, unknown_block_ids: [] },
  });
  const b = await buildBundle("readme", { guides: ["Tool Guide"] }, request);
  assert.ok(
    b.errors.some(
      (x) => x.section === "readme" && x.message === "Notion marked the README truncated; tables past the cut can't be read",
    ),
  );
  assert.equal(b.guides["Tool Guide"], null);
  assert.match(b.errors.find((x) => x.section === "guides.Tool Guide").message, /truncated/);
});

test("preferences follow next_cursor", async () => {
  const { calls, request } = fakeNotion({
    [`POST /v1/data_sources/${PREFS_ID}/query`]: (r) =>
      r.body.start_cursor === "c2"
        ? { object: "list", results: [page("Two", "Default", ["Whole workspace"])], has_more: false, next_cursor: null }
        : { object: "list", results: [page("One", "Taste", ["Whole workspace"])], has_more: true, next_cursor: "c2" },
  });
  const b = await buildBundle("readme", {}, request);
  assert.deepEqual(
    b.preferences.rows.map((r) => r.Preference),
    ["One", "Two"],
  );
  const queries = calls.filter((r) => r.method === "POST");
  assert.equal(queries.length, 2);
  assert.equal(queries[1].body.start_cursor, "c2");
});

test("README failure throws", async () => {
  const { request } = fakeNotion({
    "GET /v1/pages/readme/markdown": () => {
      throw new Error("Notion API 404 object_not_found: no README");
    },
  });
  await assert.rejects(buildBundle("readme", {}, request), /readme.*Notion API 404|Notion API 404.*readme/i);
});
