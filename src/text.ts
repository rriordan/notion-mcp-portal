export const MAX_TEXT = 24_000; // chars returned to the model per call

/** Wrap a value as an MCP text result: compact JSON (no indentation), truncated at MAX_TEXT. */
export function text(value: unknown, isError = false) {
  let t = typeof value === "string" ? value : JSON.stringify(value);
  if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT) + `\n…[truncated ${t.length - MAX_TEXT} chars]`;
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
