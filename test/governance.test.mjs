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
