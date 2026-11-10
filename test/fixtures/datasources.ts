// Fake raw data sources in Notion's 2025-09-03 shape (fake IDs).
import { AL_ID, PREFS_ID } from "./readme.ts";

const opt = (id: string, name: string, color: string) => ({ id, name, color, description: null });

export const AL_DS = {
  object: "data_source",
  id: AL_ID,
  title: [{ type: "text", plain_text: "Activity Log" }],
  properties: {
    Result: {
      id: "Hy%3ER",
      name: "Result",
      description: null,
      type: "select",
      select: { options: [opt("o1", "Success", "green"), opt("o2", "Failed", "red")] },
    },
    Summary: { id: "a%3Db", name: "Summary", description: "One line, past tense.", type: "rich_text", rich_text: {} },
    Task: { id: "title", name: "Task", description: "", type: "title", title: {} },
  },
};

export const PREFS_DS = {
  object: "data_source",
  id: PREFS_ID,
  properties: {
    Status: {
      id: "s1",
      name: "Status",
      description: "Agents set Adopted only after approval.",
      type: "select",
      select: { options: [opt("p", "Proposed", "gray"), opt("a", "Adopted", "green")] },
    },
    Scope: {
      id: "s2",
      name: "Scope",
      description: null,
      type: "multi_select",
      multi_select: { options: [opt("w", "Whole workspace", "blue"), opt("t", "Team A", "red")] },
    },
    Strength: { id: "s3", name: "Strength", type: "select", select: { options: [opt("g", "Guardrail", "red")] } },
    Preference: { id: "title", name: "Preference", type: "title", title: {} },
    Evidence: { id: "s4", name: "Evidence", type: "rich_text", rich_text: {} },
  },
};
