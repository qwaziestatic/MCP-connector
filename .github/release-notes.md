**This is a beta.** Everything an agent changes still waits for your approval
in the app, but expect rough edges, and please report problems in
[Issues](https://github.com/qwaziestatic/MCP-connector/issues).

## Install (Windows 10 or 11, 64-bit)

1. Download the `MCP-Connector-…-x64.exe` file below and run it.
2. This beta is not code-signed yet, so Windows may say **"Windows protected
   your PC"**. Click **More info**, then **Run anyway**.
3. In MCP Connector, choose the folder agents may read, connect the services
   you want, and click **Start MCP server**.
4. Under **Copy the setup for your agent**, copy the setup for Claude Code,
   Cursor, VS Code (Copilot), Codex, Gemini CLI or Windsurf, and put it where
   the app says.

To teach your agent how to use MCP Connector, also add the skill: download
`mcp-connector-skill.zip` and unzip it into your agent's skills folder (for
Claude Code, `%USERPROFILE%\.claude\skills`).

## The Linux AppImage

The AppImage needs FUSE 2. On Ubuntu 24.04 and newer, install it with
`sudo apt install libfuse2t64`; on Ubuntu 22.04, with `sudo apt install libfuse2`.

**Ubuntu 23.10 and newer** restrict the user namespaces that MCP Connector's
sandbox needs, for programs AppArmor doesn't know. The .deb installs an
AppArmor profile that allows them, so it starts normally. The AppImage has no
profile: MCP Connector then says it can't start safely and closes, rather than
run without its sandbox. Either install the .deb, or allow the AppImage with
this profile, which covers `MCP-Connector-*.AppImage` files anywhere in your
home folder:

```sh
sudo tee /etc/apparmor.d/mcp-connector-appimage > /dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile mcp-connector-appimage @{HOME}/**/MCP-Connector-*.AppImage flags=(unconfined) {
  userns,
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/mcp-connector-appimage
```

Don't start it with `--no-sandbox`: MCP Connector refuses to run that way.

## Also attached

- `mcp-connector-vscode-….vsix`: the optional VS Code extension that shares
  your active editor with MCP Connector.

## Known limits

- Notion sign-in isn't available yet; it comes in a later release. GitHub
  sign-in and the other MCP servers you add work now.
- No automatic updates yet: download new versions from this page.
- MCP servers you add with `npx` need Node.js installed.
