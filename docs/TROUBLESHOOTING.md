# Troubleshooting

Every one of these happened during the original build.

| Symptom | Cause | Fix |
|---|---|---|
| MCP server never reaches **Ready**: status "waiting", authentication "required" | The server's Access app has an empty Managed OAuth redirect allowlist, so the dashboard's OAuth callback is rejected | Add the dashboard callback and `https://<portal-host>/servers-callback` to that app's **Allowed redirect URIs** ([SETUP step 3](SETUP.md#3-protect-the-worker-with-access)) |
| Client says **"Couldn't register with … sign-in service"** | The portal app's redirect allowlist doesn't include that client's callback | Add the client's callback to the **portal** app (for Claude: `https://claude.ai/api/mcp/*`, `https://claude.com/api/mcp/*`) |
| Agent fails with **`400 invalid_client_metadata … redirect_uri is not allowed`** | The agent is trying OAuth Dynamic Client Registration | Remove the agent's OAuth config and send `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. Don't widen the allowlist to fit it |
| Portal says **"No allowed servers available"** | The portal-side Access app for the server has no policy that matches you, or the server needs re-authentication | Attach your email policy (and the Service Auth policy for agents) to the portal-side app, then re-authenticate the server |
| Service-token agent sees no tools | The server still has **Require user auth** on; the portal leaves out servers that need a per-user grant | Turn Require user auth off for that server in the portal |
| Worker returns **401 Unauthorized** after a successful login | `ACCESS_AUD` doesn't match the Access app protecting the Worker hostname | Copy the AUD tag from that app into `wrangler.jsonc` and redeploy |
| **500 "NOTION_TOKEN secret is not set"** | The secret is missing | `npx wrangler secret put NOTION_TOKEN` |
| Notion **`object_not_found`** or empty search results | The page isn't shared with the integration | In Notion: **••• → Connections → your integration** |
| Notion **`restricted_resource`** | The integration lacks a capability | Enable it in the integration's settings |
| Scripted client gets **403 / error 1010** | Browser Integrity Check is blocking non-browser user agents | Disable BIC only for `/mcp` and the OAuth discovery paths ([SETUP step 8](SETUP.md#8-hardening)) |
| Server added to the portal but **missing after save** | It was added before the server reached Ready | Wait for Ready, add it again, and confirm via the dashboard or API |

## Anyone can log in

If your Access policy has a login-method rule (e.g. "Google" or "One-time PIN") **next to** your email rule, it lets in anyone who can authenticate with that method. Include rules are OR'd.

Fix: make the policy contain only your email. Control *how* people log in with the app's **identity providers** setting, not with policy rules.

## Agent keepalives in the Access log

An agent connected by service token may log an Access event every few minutes. Many MCP clients ping on a fixed interval (for example every 180 seconds) to keep the session alive. That's a keepalive on one session, not a reconnect loop.
