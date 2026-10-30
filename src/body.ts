/**
 * Some MCP clients (claude.ai among them) send notion_request's body as a JSON string.
 * Notion needs the object itself; encoding the string again makes it reject the request.
 */
export function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("body must be a JSON object (got a string that isn't valid JSON)");
  }
}
