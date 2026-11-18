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

type Scalar = string | number | boolean;
type Query = Record<string, Scalar | Scalar[] | undefined>;

/**
 * Notion takes filter_properties only in the query string; in a body it answers
 * "400 validation_error: body.filter_properties should be not present". Agents put it in the
 * body often enough (a data source *query* reads like it wants the body) that the server moves
 * it to the query string, joined with any filter_properties already there.
 */
export function hoistFilterProperties<R extends { query?: Query; body?: unknown }>(req: R): R {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || !("filter_properties" in body)) return req;
  const { filter_properties: moved, ...rest } = body as Record<string, unknown>;
  const list = (v: unknown): Scalar[] => (v === undefined ? [] : Array.isArray(v) ? (v as Scalar[]) : [v as Scalar]);
  const merged = [...new Set([...list(req.query?.filter_properties), ...list(moved)])];
  return { ...req, query: { ...req.query, filter_properties: merged }, body: rest };
}
