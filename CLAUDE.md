# notion-mcp-portal: agent notes

A Notion API MCP server on Cloudflare Workers (`src/server.ts`), protected by Cloudflare Access and served through an MCP server portal. Production is live and other agents depend on it daily. Setup and architecture: `README.md`, `docs/SETUP.md`, `docs/TROUBLESHOOTING.md`.

## Verify every change
Run these in order. A PR opens only when all of them pass.
1. `npm ci` (once per checkout or worktree).
2. `cp wrangler.example.jsonc wrangler.jsonc` if it's missing. The real config is gitignored; CI builds against the example too.
3. `npm run check`: typecheck plus a deploy dry-run.
4. `npm test`. The `test` script lists files explicitly, so register any new `test/*.test.mjs` there.
5. `npm run test:e2e`: the real Worker against a mock Notion. When other worktrees may be running, set `E2E_PORT` to the port your brief gives you (default 8788).

## Conventions
- One concern per PR. Title it like the git log: `area: change (version)`.
- For a user-visible change, bump `version` in `package.json` and add a section at the top of `CHANGELOG.md`: version heading, one-line summary, then `### Added` / `### Changed` / `### Fixed`. The "Deployed … as version" line is written at release; leave it out.
- `src/notion-openapi.json` is third-party (makenotion/notion-mcp-server). Leave it as shipped.
- Update `README.md` and `docs/` in the same PR when behaviour changes.

## Boundaries
Your finish line is an open PR from your own branch. Robert releases (README → Releasing).
- Deploys, secrets, merges and Cloudflare changes belong to Robert; `.claude/settings.json` deny-lists them. The example config names the production Worker, so a deploy from a checkout would replace production with an unconfigured, fail-closed build.
- Preview URLs are off on purpose (`preview_urls: false`) so Access can't be bypassed through another URL. Verify locally and keep them off.
- `.dev.vars` and `.env` hold secrets: leave them unread.

## Finish
Push your branch, then `gh pr create` with a body covering what changed and why, the verify results (pass/fail counts), and anything left open. End your final message with the JSON report your brief asks for.
