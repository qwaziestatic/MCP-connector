# Notion sign-in service

Notion's token endpoint needs the integration's **client secret**, and a secret
cannot be hidden inside an installer: anyone could take it out. This small
Cloudflare Worker holds the secret instead. MCP Connector sends the browser
through it to Notion, and asks it to exchange the sign-in code for tokens.

```text
MCP Connector ──browser──▶ /notion/start ──▶ Notion's consent page
                                               │
MCP Connector ◀── http://127.0.0.1:<port> ◀── /notion/callback
MCP Connector ──── POST /notion/token {code} ──▶ Worker ──(client secret)──▶ Notion
```

The Worker stores nothing and logs nothing. Tokens pass through it in the
response and are kept only in the app's encrypted vault. It redirects only to
`127.0.0.1` on the user's own computer. The free Workers plan is more than
enough: each sign-in takes three requests.

## Set it up

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and a
Notion account. Run the commands in PowerShell from this folder
(`apps/notion-sign-in-worker`).

1. **Sign in to Cloudflare.** This opens the browser once:

   ```powershell
   npx wrangler@4 login
   ```

2. **Deploy the Worker** to get its address:

   ```powershell
   npx wrangler@4 deploy
   ```

   The first time, Wrangler may ask you to choose a `workers.dev` subdomain.
   It prints the address, for example
   `https://mcp-connector-notion-sign-in.<your-subdomain>.workers.dev`.
   Opening it now shows that the Notion settings are missing; that is expected.

3. **Create a public Notion integration** at
   [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
   (Notion's newer pages may call it a *connection*):
   - Type: **Public**.
   - Redirect URI: the Worker's address followed by `/notion/callback`, for
     example `https://mcp-connector-notion-sign-in.<your-subdomain>.workers.dev/notion/callback`.
     It must match exactly.
   - Capabilities: **Read content** and **Insert content**. User information
     is not needed.
   - Notion asks public integrations for a website, privacy policy, and terms
     of use; the repository's URL works while you test.

   Save, then copy the **OAuth client ID** and **OAuth client secret**.

4. **Give the Worker the two values.** Each command asks you to paste the value,
   so it never lands in a file or in your shell history:

   ```powershell
   npx wrangler@4 secret put NOTION_CLIENT_ID
   npx wrangler@4 secret put NOTION_CLIENT_SECRET
   ```

5. **Check it.** Open the Worker's address in a browser. It should say
   *"MCP Connector's Notion sign-in service is running."*

6. **Build MCP Connector with the address**, as described in
   [DEPLOYMENT.md](../../DEPLOYMENT.md#notion):

   ```powershell
   $env:MCP_NOTION_SIGN_IN_URL = "https://mcp-connector-notion-sign-in.<your-subdomain>.workers.dev"
   ```

If the secret ever leaks, generate a new one in Notion's integration settings
and run step 4 again. Installed copies of the app keep working, because they
never had the secret.

## Routes

| Route | What it does |
| --- | --- |
| `GET /` | Says whether the service is set up. |
| `GET /notion/start?port=P&state=S` | Sends the browser to Notion's consent page. |
| `GET /notion/callback` | Notion returns here; sends the browser back to `http://127.0.0.1:P/oauth/callback`. |
| `POST /notion/token` `{"code": "..."}` | Exchanges the code for tokens. |
| `POST /notion/refresh` `{"refresh_token": "..."}` | Renews the tokens. |

## Develop

```powershell
npm test --workspace=@mcp-connector/notion-sign-in-worker
```

To run it locally, put the two values in a `.dev.vars` file in this folder
(it is ignored by git) and start it:

```text
NOTION_CLIENT_ID=...
NOTION_CLIENT_SECRET=...
```

```powershell
npx wrangler@4 dev
```

It listens on `http://127.0.0.1:8787`. Start the app with
`$env:MCP_NOTION_SIGN_IN_URL = "http://127.0.0.1:8787"` to use it; signing in
also needs `http://127.0.0.1:8787/notion/callback` as a redirect URI on the
Notion integration.
