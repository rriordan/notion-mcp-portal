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

// ---------------------------------------------------------------------------
// Final-review fixes: no quietly empty sections
// ---------------------------------------------------------------------------
const withOptions = (prop, type, names) => ({
  ...PREFS_DS,
  properties: {
    ...PREFS_DS.properties,
    [prop]: { ...PREFS_DS.properties[prop], type, [type]: { options: names.map((name) => ({ name })) } },
  },
});

test("a missing Whole workspace option errors by name", async () => {
  const { request } = fakeNotion({
    [`GET /v1/data_sources/${PREFS_ID}`]: withOptions("Scope", "multi_select", ["Workspace-wide", "Team A"]),
    [`POST /v1/data_sources/${PREFS_ID}/query`]: { object: "list", results: [], has_more: false, next_cursor: null },
  });
  const b = await buildBundle("readme", {}, request);
  assert.equal(b.preferences, null);
  assert.match(b.errors.find((x) => x.section === "preferences").message, /Whole workspace/);
});

test("a missing Adopted option, or a Status that isn't a select, errors by name", async () => {
  const renamed = fakeNotion({
    [`GET /v1/data_sources/${PREFS_ID}`]: withOptions("Status", "select", ["Proposed", "Accepted"]),
  });
  const a = await buildBundle("readme", {}, renamed.request);
  assert.equal(a.preferences, null);
  assert.match(a.errors.find((x) => x.section === "preferences").message, /Adopted/);

  const statusType = fakeNotion({
    [`GET /v1/data_sources/${PREFS_ID}`]: withOptions("Status", "status", ["Proposed", "Adopted"]),
  });
  const s = await buildBundle("readme", {}, statusType.request);
  assert.equal(s.preferences, null);
  assert.match(s.errors.find((x) => x.section === "preferences").message, /select/);
});

test("unrendered README blocks are not reported as truncation", async () => {
  const { request } = fakeNotion({
    "GET /v1/pages/readme/markdown": { object: "page_markdown", markdown: README_MD, truncated: false, unknown_block_ids: ["blk-1"] },
  });
  const b = await buildBundle("readme", { guides: ["Nope"] }, request);
  const readmeErrors = b.errors.filter((x) => x.section === "readme");
  assert.equal(readmeErrors.length, 1);
  assert.doesNotMatch(readmeErrors[0].message, /truncated/);
  assert.match(readmeErrors[0].message, /blk-1/);
  assert.doesNotMatch(b.errors.find((x) => x.section === "guides.Nope").message, /truncated/);
  assert.ok(b.activity_log_fields && b.preferences);
});

test("a guide with no markdown errors instead of returning empty", async () => {
  const { request } = fakeNotion({ [`GET /v1/pages/${GUIDE_ID}/markdown`]: { object: "page" } });
  const b = await buildBundle("readme", { guides: ["Tool Guide"] }, request);
  assert.equal(b.guides["Tool Guide"], null);
  assert.match(b.errors.find((x) => x.section === "guides.Tool Guide").message, /markdown/);
});

// ---------------------------------------------------------------------------
// sections: a follow-up call that leaves the core out
// ---------------------------------------------------------------------------
test("sections: [] returns only the named guides and skips the core reads", async () => {
  const { calls, request } = fakeNotion();
  const b = await buildBundle("readme", { sections: [], guides: ["Tool Guide"] }, request);
  assert.deepEqual(Object.keys(b), ["errors", "guides"]);
  assert.deepEqual(b.guides["Tool Guide"], { id: GUIDE_ID, markdown: "# Tool Guide" });
  // The README is still read (it resolves the guide), but neither store is.
  assert.deepEqual(calls.map((r) => `${r.method} ${r.path}`).sort(), [`GET /v1/pages/${GUIDE_ID}/markdown`, "GET /v1/pages/readme/markdown"]);
});

test("sections picks core sections one by one", async () => {
  const { calls, request } = fakeNotion();
  const b = await buildBundle("readme", { sections: ["preferences"], scope: "Team A" }, request);
  assert.deepEqual(Object.keys(b), ["errors", "preferences"]);
  assert.equal(b.preferences.rows.length, 1);
  assert.ok(!calls.some((r) => r.path === `/v1/data_sources/${AL_ID}`));
});

// ---------------------------------------------------------------------------
// fitBundle: a bundle over the reply cap keeps whole sections and lists the rest in `pending`
// ---------------------------------------------------------------------------
import { fitBundle } from "../src/governance.ts";

const x = (n) => "x".repeat(n);
const guide = (n) => ({ id: `g${n}`, markdown: x(n) });
const core = () => ({
  errors: [],
  readme: { id: "r", markdown: x(1000) },
  activity_log_fields: { data_source_id: "al", fields: [] },
  preferences: { scope: "Team A", rows: [] },
});
const BUDGET = 5000;
const fits = (b) => JSON.stringify(b).length <= BUDGET;

test("fitBundle leaves a bundle under the cap alone", () => {
  const b = { ...core(), guides: { A: guide(3000) } };
  assert.equal(fitBundle(b, "Team A", BUDGET), b);
});

test("fitBundle keeps the core and moves guides that don't fit to pending", () => {
  const out = fitBundle({ ...core(), guides: { A: guide(3000), B: guide(3000) } }, "Team A", BUDGET);
  assert.ok(fits(out));
  assert.equal(Object.keys(out)[0], "errors");
  assert.equal(out.readme.markdown.length, 1000);
  assert.ok(out.activity_log_fields && out.preferences);
  assert.deepEqual(Object.keys(out.guides), ["A"]);
  assert.deepEqual(out.pending, { sections: [], guides: ["B"] });
});

test("fitBundle skips what doesn't fit and still takes later, smaller items", () => {
  const big = { data_source_id: "s", fields: [{ name: x(3000), type: "title" }] };
  const out = fitBundle(
    { ...core(), schemas: { Big: big, Small: { data_source_id: "t", fields: [] } }, guides: { A: guide(3000), B: guide(3000), C: guide(50) } },
    undefined,
    BUDGET,
  );
  assert.ok(fits(out));
  assert.deepEqual(Object.keys(out.schemas), ["Big", "Small"]);
  assert.deepEqual(Object.keys(out.guides), ["C"]);
  assert.deepEqual(out.pending, { sections: [], guides: ["A", "B"] });
});

test("fitBundle: a guide too long for any reply is nulled with the call that reads it", () => {
  const out = fitBundle({ ...core(), guides: { A: guide(6000), B: guide(50) } }, undefined, BUDGET);
  assert.ok(fits(out));
  assert.equal(out.guides.A, null);
  assert.equal(out.guides.B.markdown.length, 50);
  const e = out.errors.find((r) => r.section === "guides.A");
  assert.match(e.message, /GET \/v1\/pages\/g6000\/markdown/);
  assert.ok(!("pending" in out));
});

test("fitBundle: a core that is itself over the cap sheds sections to pending, with the scope", () => {
  const b = core();
  b.activity_log_fields.fields = [{ name: x(2500), type: "title" }];
  b.preferences.rows = [{ Preference: x(2500) }];
  const out = fitBundle(b, "Team A", BUDGET);
  assert.ok(fits(out));
  assert.ok(out.readme && out.activity_log_fields);
  assert.ok(!("preferences" in out));
  assert.deepEqual(out.pending, { sections: ["preferences"], scope: "Team A" });
});

test("fitBundle: a README too long for any reply is nulled with the call that reads it", () => {
  const b = core();
  b.readme.markdown = x(6000);
  const out = fitBundle(b, undefined, BUDGET);
  assert.ok(fits(out));
  assert.deepEqual(out.readme, { id: "r", markdown: null });
  assert.match(out.errors.find((r) => r.section === "readme").message, /GET \/v1\/pages\/r\/markdown/);
  assert.ok(out.activity_log_fields && out.preferences);
});

test("following pending returns the rest", async () => {
  const long = "g".repeat(3200);
  const { request } = fakeNotion({ [`GET /v1/pages/${GUIDE_ID}/markdown`]: { object: "page_markdown", markdown: long, truncated: false } });
  const args = { scope: "Team A", guides: ["Tool Guide"] };
  const budget = JSON.stringify(await buildBundle("readme", { scope: "Team A" }, request)).length + 3000;
  const first = fitBundle(await buildBundle("readme", args, request), args.scope, budget);
  assert.deepEqual(first.pending, { sections: [], guides: ["Tool Guide"] });
  const rest = fitBundle(await buildBundle("readme", first.pending, request), first.pending.scope, budget);
  assert.deepEqual(Object.keys(rest), ["errors", "guides"]);
  assert.equal(rest.guides["Tool Guide"].markdown, long);
});
