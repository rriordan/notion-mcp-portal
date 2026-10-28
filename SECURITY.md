# Security

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it.

## Scope

In scope: the Worker code in `src/`, and anything in the docs that would lead someone to an insecure setup (for example, a policy or redirect allowlist that lets in more than intended).

Out of scope: Cloudflare Access, MCP server portals and the Notion API themselves. Report those to Cloudflare or Notion.

## Keep your Access policy to your email

Access ORs the include rules in a policy. A login-method rule such as "Google" or "One-time PIN" next to your email rule lets in anyone who can sign in that way, not just you. Put only your email in the policy, and pick login methods in the app's **Identity providers** setting instead.

## If you deploy this

- Never deploy `test/dev-entry.ts`; it skips the Access check.
- Keep `ACCESS_AUD` set. Without it the Worker rejects every request, which is safe, but don't "fix" that by removing the check.
- Share only the Notion pages your agents need with the integration.
- Rotate service tokens before they expire, and revoke any you don't use.
