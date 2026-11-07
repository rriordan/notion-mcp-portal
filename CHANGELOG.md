# Changelog

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
