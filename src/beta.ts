/**
 * Opt-in Notion API betas (the Notion-Beta header).
 *
 * A beta can change an existing endpoint's contract (stricter validation, different response
 * shapes), so callers opt in per request with `betas`, and only flags listed here are sent.
 * Adding a flag is a reviewed code change, not something a caller can do. Requests without
 * `betas` send no Notion-Beta header and behave exactly as before.
 *
 * Flag format (https://developers.notion.com/reference/versioning#beta-versions):
 * kebab-case name plus revision date, <beta-name>-<YYYY-MM-DD>; several are comma-separated.
 */

/** Betas this server will send. Revision dates matter: Notion rejects a superseded revision. */
export const BETA_FLAGS = [
  // Status group filters: group_equals / group_does_not_equal on status properties; with the
  // flag, equals / does_not_equal match option names only. Announced in Notion's 2026-11-18 changelog.
  // https://developers.notion.com/reference/filter-data-source-entries#status-group-filters-beta
  "status-group-filters-2026-10-06",
] as const;

export type BetaFlag = (typeof BETA_FLAGS)[number];

const FLAG = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const ALLOWED: ReadonlySet<string> = new Set(BETA_FLAGS);

/**
 * The Notion-Beta header value for `betas`, or undefined when there are none.
 * Throws on anything malformed, not allowlisted, or repeated, so nothing unvetted reaches Notion.
 */
export function betaHeader(betas: unknown): string | undefined {
  if (betas === undefined) return undefined;
  if (!Array.isArray(betas)) throw new Error("betas must be an array of beta flags");
  if (betas.length === 0) return undefined;
  const seen = new Set<string>();
  for (const flag of betas) {
    if (typeof flag !== "string" || !FLAG.test(flag)) {
      throw new Error(`betas: malformed flag ${JSON.stringify(flag)}; expected <beta-name>-<YYYY-MM-DD>, e.g. "${BETA_FLAGS[0]}"`);
    }
    if (!ALLOWED.has(flag)) {
      throw new Error(`betas: "${flag}" is not enabled on this server. Allowed: ${BETA_FLAGS.map((f) => `"${f}"`).join(", ")}`);
    }
    if (seen.has(flag)) throw new Error(`betas: "${flag}" is given more than once`);
    seen.add(flag);
  }
  return [...seen].join(",");
}

const NAMED_FLAG = /Notion-Beta:\s*([a-z0-9-]+)/i;

/**
 * Notion's 400 for a beta-only feature names the header it wants ("require the
 * \"Notion-Beta: <flag>\" header"). When that flag is allowlisted and wasn't sent, say how to send it.
 */
export function betaHint(message: string | undefined, sent: readonly string[] | undefined): string {
  const flag = message?.match(NAMED_FLAG)?.[1];
  if (!flag || !ALLOWED.has(flag) || sent?.includes(flag)) return "";
  return ` Call notion_request again with betas: ["${flag}"].`;
}
