# Setup

Replace `example.com` with a domain on your Cloudflare account and `your-team` with your Zero Trust team name. The examples use two hostnames:

- `notion.example.com`: the Worker
- `mcp.example.com`: the MCP server portal

## Prerequisites

- A domain on Cloudflare (DNS proxied by Cloudflare)
- Cloudflare Zero Trust enabled on the account, with at least one login method (identity provider)
- Node.js 20+
- A Notion workspace where you can create integrations

## 1. Notion integration

1. Create an **internal integration** at <https://www.notion.so/profile/integrations>. Give it only the capabilities you need (read content, update content, insert content, comments).
2. Copy its token. You'll store it as a Worker secret in step 2, and nowhere else.
3. In Notion, share each page or database the server should see: **••• → Connections → your integration**. Child pages inherit access.

## 2. Deploy the Worker

```bash
git clone https://github.com/<you>/notion-mcp-portal.git
cd notion-mcp-portal
npm ci
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc` is gitignored, so your hostname and AUD tag stay out of git. Edit it:

- `routes[0].pattern` → `notion.example.com`
- `ACCESS_TEAM_DOMAIN` → `your-team.cloudflareaccess.com`
- leave `ACCESS_AUD` empty for now

```bash
npx wrangler login
npm run check
npm run deploy
npx wrangler secret put NOTION_TOKEN   # paste the token at the prompt
```

At this point every request except `/health` returns 401. That's expected, because `ACCESS_AUD` isn't set yet.

## 3. Protect the Worker with Access

In Zero Trust → **Access controls → Applications**, add an application of type **MCP server** for `notion.example.com`:

1. **Policy:** allow your own email only. Use the email rule alone, with no login-method rules (see [SECURITY.md](../SECURITY.md#keep-your-access-policy-to-your-email)).
2. **Managed OAuth:** on, with Dynamic Client Registration on.
3. **Allowed redirect URIs:** add both of these:
   - `https://dash.cloudflare.com/<account-id>/one/access-controls/ai-controls/mcp-server/oauth-callback/<server-id>` (the dashboard's callback for the MCP server you create in step 4; `<server-id>` is the ID you give it)
   - `https://mcp.example.com/servers-callback` (the portal's callback)

Copy the app's **Application Audience (AUD) tag** into `ACCESS_AUD` in `wrangler.jsonc`, then:

```bash
npm run deploy
```

Check that Access is in front: `curl -si https://notion.example.com/health` should now return an Access response (401, 302 or 403), not `ok`.

## 4. Register the MCP server

Zero Trust → **Access controls → AI controls → MCP servers → Add**:

- **ID:** e.g. `notion-api` (this is the `<server-id>` in the callback above)
- **Hostname:** `https://notion.example.com/mcp`
- **Auth:** OAuth

Then **••• → Authenticate**, log in, and wait for status **Ready**. If it stays at "authentication required", the redirect allowlist from step 3 is incomplete.

## 5. Create the portal

**AI controls → MCP portals → Add**, hostname `mcp.example.com`.

1. **Wait until the server shows Ready**, then add it under MCP servers.
2. **Require user auth:**
   - **On:** each person runs their own OAuth grant against the server.
   - **Off:** the portal uses the credential from step 4. Required if any agent will connect with a service token (step 7).
3. Open the portal's Access application (**Applications → your portal → Managed OAuth**) and set its **Allowed redirect URIs** to the callbacks of the clients you'll use:
   - Claude: `https://claude.ai/api/mcp/*` and `https://claude.com/api/mcp/*`
   - ChatGPT: `https://chatgpt.com/connector/oauth/*`
4. Set the portal app's policy to your email, the same as in step 3.

## 6. Connect a client

In Claude: **Settings → Connectors → Add custom connector**, URL `https://mcp.example.com/mcp`. Log in when prompted.

Test it: ask Claude to call `notion_request` with `GET /v1/users/me`. You should get your integration's bot user back.

## 7. Optional: headless agents (service token)

1. **Access controls → Service credentials → Create service token.** Store the client ID and secret in a secrets manager.
2. Create a reusable policy with action **Service Auth** that includes only that token.
3. Attach it to **both** the portal's Access app and the portal-side Access app for the server (it's created for you, destination "via MCP server portal"). Give it a lower precedence than your email policy.
4. Make sure the server's **Require user auth** is off in the portal (step 5).
5. Configure the agent's MCP client with **no OAuth**, just two headers:

```yaml
# example: an agent whose MCP config accepts static headers
mcp_servers:
  notion:
    url: https://mcp.example.com/mcp
    headers:
      CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}       # load from your secrets manager,
      CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET} # never inline
```

Check it in **Logs → Access**: requests to `mcp.example.com/mcp` should show as allowed, with connection `nonidentity` and the token's client ID as the identity.

Service tokens expire. Put the expiry date in your calendar and rotate before then: create a new token, update the secrets and the policy, confirm the agent connects, then delete the old token.

## 8. Hardening

- **Session lengths.** On the portal app, a 24h Access session, a 15m OAuth access token and a 2-week grant work well. Hosted clients then re-authorize every two weeks.
- **Browser Integrity Check.** If scripted clients get error 1010, add a configuration rule that turns BIC off only for `notion.example.com` on these paths:
  - `/mcp`
  - `/.well-known/oauth-protected-resource`
  - `/.well-known/oauth-protected-resource/mcp`
  - `/.well-known/cloudflare-access-protected-resource/mcp`
  - `/.well-known/oauth-authorization-server`
- **Notion sharing.** Review which pages the integration can see from time to time.
