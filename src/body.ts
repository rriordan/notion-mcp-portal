/**
 * Some MCP clients (claude.ai among them) send notion_request's body as a JSON string,
 * sometimes encoded twice. Notion needs the object itself; sending the string makes it
 * reject the request with "invalid_json".
 */
export function parseBody(body: unknown): unknown {
  let value = body;
  // Unwrap up to three layers of JSON string encoding.
  for (let i = 0; i < 3 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("body must be a JSON object (got a string that isn't valid JSON)");
    }
  }
  if (typeof value === "string") throw new Error("body must be a JSON object (got a string)");
  return value;
}
