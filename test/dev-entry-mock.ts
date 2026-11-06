// LOCAL TESTING ONLY - skips the Access check and replaces api.notion.com with test/mock-notion.ts.
import { handleMcp, type Env } from "../src/server";
import { mockFetch } from "./mock-notion";
globalThis.fetch = mockFetch as typeof fetch;
export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => handleMcp(req, env, ctx),
};
