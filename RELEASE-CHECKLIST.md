# Release checklist

This checklist separates automated release validation from tests that require
a real Windows machine, provider accounts, or release credentials.

## Automated checks

- [ ] GitHub Actions CI is green for the release commit.
- [ ] `npm ci` completes without modifying the lockfile.
- [ ] `npm run prisma:generate` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] `npm audit --omit=dev` reports zero runtime vulnerabilities.
- [ ] `npm audit --audit-level=high` reports no high or critical advisories.
- [ ] `npm run package:win` produces the expected x64 NSIS installer.
- [ ] `npm run smoke-test --workspace=@mcp-connector/desktop` passes: the
      packaged app starts, loads its database, and starts its local servers.
- [ ] `npm run package:vscode` produces the expected VSIX.
- [ ] No secrets, certificates, databases, or generated artifacts are tracked.

## Signing and branding

- [ ] Replace the default Electron icon with the approved `.ico` asset.
- [ ] Configure `CSC_LINK` and `CSC_KEY_PASSWORD` in a protected signing
      environment.
- [ ] Run `npm run package:win:signed --workspace=@mcp-connector/desktop`.
- [ ] Verify Authenticode signatures on the installer and application files.
- [ ] Never commit certificates, passwords, or signing environment files.

## Clean Windows machine

- [ ] Install the signed NSIS installer as a standard user.
- [ ] Confirm Start Menu and Desktop shortcuts.
- [ ] Launch the application and confirm the SQLite database is created under
      `%APPDATA%\\mcp-connector`.
- [ ] Select a workspace and verify filesystem inspection stays inside the
      selected root.
- [ ] Create a mutating preview and confirm approval is required before
      execution.
- [ ] Restart the application and verify persisted preview state and audit
      history.
- [ ] Upgrade from the previous release and verify the database remains intact.
- [ ] Uninstall and verify the documented application-data retention behavior.

## Provider validation

- [ ] Create the GitHub OAuth app with device flow turned on, and set the
      `MCP_GITHUB_CLIENT_ID` repository variable (DEPLOYMENT.md, "Sign-in setup").
- [ ] Test GitHub sign-in with the code, a declined and an expired code,
      Cancel, disconnect, a revoked token, and rate limit behavior.
- [ ] Deploy `apps/notion-sign-in-worker`, register its `/notion/callback`
      address on the Notion integration, and set the `MCP_NOTION_SIGN_IN_URL`
      repository variable. Its home page must say it is running.
- [ ] Test Notion sign-in, a declined sign-in, Cancel, permission failure,
      and page creation after explicit approval.
- [ ] Confirm the installer contains no client secret: only the GitHub client
      ID and the sign-in service address are built in.

## Auto-update validation

- [ ] Publish signed artifacts and updater metadata to the configured feed.
- [ ] Set `MCP_UPDATER_ENABLED=true` and a protected
      `MCP_UPDATE_FEED_URL`.
- [ ] Verify check, available, download, and explicit install/restart states.
- [ ] Verify an invalid or unavailable feed produces a visible error without
      blocking normal application startup.
- [ ] Test rollback or recovery behavior before broad distribution.

## GitHub distribution

- [ ] Review generated release notes.
- [ ] Attach the signed installer and VSIX to the GitHub Release.
- [ ] Confirm repository visibility and proprietary licensing are intentional.
- [ ] Announce the exact version and SHA-256 hashes of release artifacts.
