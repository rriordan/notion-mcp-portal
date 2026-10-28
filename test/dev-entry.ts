// LOCAL TESTING ONLY - skips the Access check. Never deploy this entry.
import { handleMcp, type Env } from "../src/server";
export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => handleMcp(req, env, ctx),
};
