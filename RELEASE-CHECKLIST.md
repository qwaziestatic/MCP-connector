# Release checklist

This checklist separates automated release validation from tests that require
a real Windows or Linux machine, provider accounts, or release credentials.

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
- [ ] On Linux, `npm run package:linux` produces the x64 AppImage and .deb.
- [ ] CI's `package-linux` job passes: the installed .deb, the AppImage and
      the unpacked app each pass the smoke test with an unlocked keyring, the
      first two with Ubuntu's AppArmor user-namespace restriction in place.
- [ ] `npm run package:vscode` produces the expected VSIX.
- [ ] No secrets, certificates, databases, or generated artifacts are tracked.

## Signing and branding

- [x] Replace the default Electron icon (`apps/desktop/assets/icon.ico`).
- [ ] Configure `CSC_LINK` and `CSC_KEY_PASSWORD` in a protected signing
      environment.
- [ ] Run `npm run package:win:signed --workspace=@mcp-connector/desktop`.
- [ ] Verify Authenticode signatures on the installer and application files.
- [ ] Never commit certificates, passwords, or signing environment files.

## Clean Windows machine

- [ ] Install the signed NSIS installer as a standard user.
- [ ] Confirm Start Menu and Desktop shortcuts.
- [ ] Launch the application and confirm the SQLite database is created under
      `%APPDATA%\@mcp-connector\desktop`.
- [ ] Select a workspace and verify filesystem inspection stays inside the
      selected root.
- [ ] Create a mutating preview and confirm approval is required before
      execution.
- [ ] Restart the application and verify persisted preview state and audit
      history.
- [ ] Upgrade from the previous release and verify the database remains intact.
- [ ] Uninstall and verify the documented application-data retention behavior.

## Clean Linux machine

Use a desktop Ubuntu 24.04 or newer, with GNOME and its keyring. The CI run's
`linux-packages` artifact has the same AppImage and .deb as a release.

- [ ] Install the .deb with `sudo apt install ./MCP-Connector-<version>-amd64.deb`.
      `/etc/apparmor.d/mcp-connector` exists, and MCP Connector starts from
      the apps menu and from `mcp-connector` in a terminal, without
      `--no-sandbox`.
- [ ] The icon shows in the apps menu, the dock and the window.
- [ ] Settings, the database and logs are created in
      `~/.config/@mcp-connector/desktop`.
- [ ] Connect GitHub with the code, then restart the app: it is still
      connected, and the token is in the keyring, not in plain text.
- [ ] Start the MCP server, copy the stdio setup, and connect an agent with it.
- [ ] With the keyring locked or GNOME Keyring removed, the app says to
      install or unlock GNOME Keyring or KWallet, and stores nothing.
- [ ] Run the AppImage after `chmod +x`, with `libfuse2t64` installed. Without
      the release notes' AppArmor profile it says it can't start safely; with
      it, it starts. Copy the stdio setup, restart the app, and the agent
      still connects: the setup points at the AppImage file, not its
      temporary mount.
- [ ] `sudo apt remove <package>` removes the app and its AppArmor profile,
      and keeps `~/.config/@mcp-connector/desktop`.

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

## Beta release (unsigned)

1. In the repository's **Settings → Secrets and variables → Actions →
   Variables**, check `MCP_GITHUB_CLIENT_ID`. Leave `MCP_NOTION_SIGN_IN_URL`
   unset until the Notion sign-in service is deployed.
2. Check `.github/release-notes.md`; it goes at the top of the release.
3. **Actions → Build release artifacts → Run workflow**: version such as
   `0.2.0-beta.1`, without a leading `v`, **prerelease** ticked. The workflow
   stops at once if the version isn't plain semver or `MCP_GITHUB_CLIENT_ID`
   is empty; otherwise it builds Windows and Linux, then makes one release.
4. On a Windows machine, download the installer from the release, install it,
   and check the icon, GitHub sign-in, **Start MCP server**, and one agent
   connecting. On a Linux machine, do the same with the .deb and the AppImage
   (see "Clean Linux machine").
5. If something is wrong, delete the release and its tag (for example
   `v0.2.0-beta.1`) on GitHub, fix it, and run the workflow again.
6. Then list the skill on the marketplace (below).

## GitHub distribution

- [ ] Review generated release notes.
- [ ] Attach the signed installer, the AppImage, the .deb and the VSIX to the
      GitHub Release.
- [ ] Run `npm run package:skill` and upload `release/mcp-connector-skill.zip`
      to the skill marketplace only after the release is public, because the
      skill's setup steps link to it.
- [ ] Confirm the release is under the MIT License, as LICENSE says.
- [ ] Announce the exact version and SHA-256 hashes of release artifacts.
