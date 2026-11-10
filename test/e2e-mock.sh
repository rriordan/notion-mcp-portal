#!/usr/bin/env bash
# End-to-end pagination check against a mock Notion (no token, no network).
# Starts the real Worker locally, walks a 250-row data source twice through MCP, stops the Worker.
#   npm run test:e2e
set -u
cd "$(dirname "$0")/.."
PORT="${E2E_PORT:-8788}"
LOG="$(mktemp)"
# Own process group, so the trap stops wrangler and workerd too, not just the npx wrapper
# (a leftover dev server would keep the port and serve the next run).
setsid npx wrangler dev -c test/wrangler.mock.jsonc --local --port "$PORT" >"$LOG" 2>&1 &
PID=$!
trap 'kill -- -"$PID" 2>/dev/null; wait "$PID" 2>/dev/null; rm -f "$LOG"' EXIT
for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  kill -0 "$PID" 2>/dev/null || { echo "wrangler dev exited early:"; cat "$LOG"; exit 1; }
  sleep 1
done
SMOKE_MCP_URL="http://127.0.0.1:$PORT/mcp" SCAN_DATA_SOURCE_ID=mock-ds SCAN_DELAY_MS=0 node test/scan.mjs &&
SMOKE_MCP_URL="http://127.0.0.1:$PORT/mcp" node test/scan-endpoints.mjs &&
SMOKE_MCP_URL="http://127.0.0.1:$PORT/mcp" node test/bundle-e2e.mjs
