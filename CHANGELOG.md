# Changelog

## Unreleased

## 1.4.0

A `governance_bundle` over the reply cap is now always valid JSON.

### Fixed

- **`governance_bundle` over 24,000 characters was cut mid-string**, so the reply wasn't JSON
  (seen with 3 guides and 2 schemas, 32,980 characters). The bundle is now fitted by whole
  sections: the core first, then schemas, then guides, each in the order asked for. What
  didn't fit is named in a top-level `pending`, which is exactly the arguments of the call
  that returns it. A single guide, schema or README too long for any reply is `null`, with the
  `notion_request` call that reads it in `errors`.
- **Bench "Saved" column** compared totals even when the reply cap left raw and compact with
  different row counts. With different counts it now reports the saving per row and says so.

### Added

- **`sections`** on `governance_bundle`: which of `readme`, `activity_log_fields` and
  `preferences` to return (omitted = all; `[]` = only the named guides and schemas). A
  `pending` follow-up uses it, so the core isn't sent or queried twice. The README is still
  read on every call, because its tables resolve everything else.

- **One log line per tool call**: `{"event":"tool_call","tool":…,"ms":…,"error":…}`, so timing a
  call is one filter in `wrangler tail` or Workers Logs. It holds no request or reply content.

### Removed

- **`offset`** on `governance_bundle`. It re-read everything live and cut by characters, so
  parts could come from different versions of a page. `pending` replaces it. `offset` on
  `notion_request` is unchanged.

### Changed

- The server's reported version now comes from `package.json`.

## 1.3.0

Governance release. Adds an optional tool that gives an agent everything it reads from a
Notion governance setup at session start in one live call. Deployments without the new var
see no change.

### Added

- **`governance_bundle`** (listed only when `GOVERNANCE_README_ID` is set). One read-only call
  returns the README page's Markdown, the Activity Log's field list (name, type, options,
  description), and the `Adopted` Preferences rows for a `scope` plus `Whole workspace`
  (`Preference`, `Strength`, `Scope` only). Optional `guides` and `schemas` (up to 3 names
  each) add guide pages and store field lists. Stores and guides are found through the
  README's own `## Where things go` and `## Guides` tables (by heading and column header), so
  no IDs live in code. `errors` is always the first key; a part that couldn't be read is
  `null` with its reason, and only an unreadable README fails the call. `offset` reads a
  bundle over the 24,000-char cap in parts.
- **One `notion_call` log line per Notion call** in Workers Logs: method, path, status, `ms`,
  retries, and whether the schema cache answered. Query strings, bodies and the token are
  never logged.
- `test/smoke.mjs`: bundle checks when the tool is listed; `SMOKE_SCOPE` and
  `SMOKE_EXPECT_BUNDLE=1`. The bench takes a `tool` call type.
- `npm run bench`: `BENCH_CALLS=users_me,page` runs only the named calls.

### Changed

- `notionRequest` takes `noCache`, which skips the 5-minute schema cache (the bundle always
  uses it, so a rule edited a minute ago shows up).
- `src/notion.ts` imports the OpenAPI JSON with `with { type: "json" }` (so `node --test` can
  load it), and `tsconfig` uses `module: ESNext`.
- README: tool-definition token counts re-measured (this server 1,746; official connector 77
  tools, 104,604). Not yet re-measured with `governance_bundle`.

### Fixed

- `test/e2e-mock.sh` left `wrangler` and `workerd` running after every run (the trap killed only
  the `npx` wrapper), so a later run could test a stale server. It now stops the whole process
  group.

## 1.2.0

Pagination and error-handling release. Fixes lists that came back with `has_more: true` and
no `next_cursor`, which scheduled agents read as a broken Notion API and stopped after the
first 8 to 12 rows.

### Behavior changes (read before upgrading)

- **A list too long for one reply is fetched again with a smaller `page_size`**, and that
  second response is returned whole. Its rows and `next_cursor` agree, so following the
  cursor skips nothing. The reply carries `page_size_reduced_to` and a `note`. 1.1.0 instead
  cut rows after the fact, dropped `next_cursor`, and forced `has_more: true`; that is now
  only the fallback when no smaller page works (for example, a single row over the cap).
  Cost: such a call makes two Notion requests the first time; the size that fit is
  remembered per endpoint in the isolate, so later pages cost one.
- **429s are retried for every method** (Notion refused the request unrun), honoring
  `Retry-After`: each wait at most 10 s, at most 3 retries. **502/503/504 and network
  failures are retried only for reads** (GET, search, queries); a write is never re-sent
  after it may have run.
- **Errors end with a tag**, `[class=rate_limited; retryable; retry_after=4s]`, so a caller
  can tell rate limits, quota (`usage_limit_reached`, not retryable), auth, not-found,
  conflict, invalid-request, upstream and network failures apart, and knows when a write was
  not repeated.

### Added

- `npm run test:e2e`: starts the real Worker against a mock Notion (250 wide rows) and walks
  it twice through MCP, checking for lost cursors, cut rows, duplicates and scan agreement.
- `test/scan.mjs`: the same walk against a live endpoint (`SCAN_DATA_SOURCE_ID`, rate-limited
  by `SCAN_DELAY_MS`); read-only.
- `test/scan-endpoints.mjs` (part of `test:e2e`): walks search, block children, comments, page
  property items and users on the mock (120 wide items each) with the same checks.

## 1.1.0

Token-efficiency release. Tool results are much smaller by default, and long results
no longer cut off silently.

### Behavior changes (read before upgrading)

- **Responses are compact by default.** `notion_request` drops nulls, opaque property and
  option ids and false flags, and returns rich text as plain text (links kept), users as
  ids and select options as names. Anything that parses Notion's full JSON must pass
  `format: "raw"`. (8c01d55)
- **GET and DELETE on `/mcp` return 405.** The server now uses the MCP SDK v2 handler:
  stateless, and it answers the portal's `server/discover` (protocol 2026-07-28) natively
  instead of failing with 400 and falling back to `initialize`. POST clients are
  unaffected. (5e6edd5)
- **`notion_find_endpoints` returns at most 8 matches** (it used to return every match for
  a broad query). (8da76ab)
- **Tool results are minified JSON**, no indentation. (2717ad1)

### Added

- `format: "values"`: rows as `{ id, url, last_edited_time, props }`, empty properties
  dropped, formulas and rollups computed. Relations with more items than Notion returned
  are flagged in `incomplete`. (1313286, df5b09c, 4829a01)
- `offset` paging for long non-list reads; a cut result ends with a marker giving the next
  offset. Writes never offer an offset, so a cut write result can't be replayed. (1313286,
  df5b09c, 4bd2798)
- Long lists keep whole rows (still valid JSON), report `truncated_rows`, and hint at a
  smaller `page_size`; `next_cursor` is dropped when rows were left out, since it would
  skip them. (df5b09c, f68c77a)
- Array query parameters repeat the key, so `filter_properties` can take several names.
- Page reads are steered to `GET /v1/pages/{id}/markdown`, returned as plain Markdown with
  Notion's truncation flags kept. (ce165ac)
- `GET` database and data source schemas are cached for 5 minutes per isolate; writes clear
  the cache.
- `npm run bench`: token counts for tool definitions and typical results. (bdf3e31)
- `npm run smoke`: read-only live checks of a running server (version, `values` vs `raw`,
  offset rules, error results, 405s). Setup is in the file header.

### Fixed

- `serverInfo.version` reported `1.0.0` for v1.0.1; it now matches the release.

## 1.0.1

Fixes after the initial release.

## 1.0.0

Initial release: Notion API MCP server on Cloudflare Workers behind Cloudflare Access and
an MCP server portal.
