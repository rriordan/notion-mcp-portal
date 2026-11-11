/**
 * One log line per MCP tool call: which tool, how long it took, whether it returned an error.
 * Nothing from the request or the reply is logged, so the line holds no page content or ids.
 * Filter `wrangler tail` (or Workers Logs) on `"event":"tool_call"` to time a call.
 */
export function timed<F extends (...args: any[]) => Promise<{ isError?: boolean }>>(
  tool: string,
  fn: F,
  now: () => number = Date.now,
  log: (line: string) => void = console.log,
): F {
  return (async (...args: Parameters<F>) => {
    const start = now();
    try {
      const result = await fn(...args);
      log(JSON.stringify({ event: "tool_call", tool, ms: now() - start, error: result.isError === true }));
      return result;
    } catch (e) {
      log(JSON.stringify({ event: "tool_call", tool, ms: now() - start, error: true }));
      throw e;
    }
  }) as unknown as F;
}
