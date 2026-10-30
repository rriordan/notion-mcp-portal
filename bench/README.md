# Token benchmark

Measures what the model pays, in tokens, for this server's tool definitions and for six typical tool results (`bench/calls.json`). It runs as an MCP client against the local dev server, so it measures the exact text a model receives. Counts come from the Anthropic token-counting API (`claude-opus-5-5` by default).

## Run it

1. Put a real Notion integration token in `test/.dev.vars` (gitignored), then start the dev server:

   ```bash
   echo "NOTION_TOKEN=<your token>" > test/.dev.vars
   npm run dev
   ```

2. In another terminal, point the calls at pages your integration can see, then run:

   ```bash
   export BENCH_QUERY="Projects" BENCH_PAGE_ID=<page id> BENCH_DATA_SOURCE_ID=<data source id>
   export ANTHROPIC_API_KEY=<key>   # load it from your secrets manager, don't type it
   npm run bench
   ```

   `npm run bench -- --no-count` skips the token API and shows character counts, which is useful for checking the setup.

## Optional: the official connector

To compare tool-definition size with Notion's hosted connector, save its tool list as `bench/official-tools.json`, an array of `{ name, description, inputSchema }` (gitignored). The benchmark counts it the same way.

## Settings

| Variable | Default |
|---|---|
| `BENCH_MCP_URL` | `http://127.0.0.1:8787/mcp` |
| `BENCH_MODEL` | `claude-opus-5-5` |

Each call runs twice: `format: "raw"` (Notion's full JSON) and the default compact output. Results over 24,000 characters are truncated by the server and marked "(truncated)".
