**This is a beta.** Everything an agent changes still waits for your approval
in the app, but expect rough edges, and please report problems in
[Issues](https://github.com/qwaziestatic/MCP-connector/issues).

## Install on Windows (10 or 11, 64-bit)

1. Download the `MCP-Connector-…-x64.exe` file below and run it.
2. This beta is not code-signed yet, so Windows may say **"Windows protected
   your PC"**. Click **More info**, then **Run anyway**.

## Install on Linux (64-bit)

- **Ubuntu, Debian and their derivatives**: download
  `MCP-Connector-…-amd64.deb` below and install it:

  ```sh
  sudo apt install ./MCP-Connector-…-amd64.deb
  ```

  Then open MCP Connector from your apps menu, or run `mcp-connector`. On
  Ubuntu 24.04, use the .deb: it allows the sandbox for itself (see below).
- **Other distributions**: download `MCP-Connector-…-x86_64.AppImage`, make
  it executable and run it:

  ```sh
  chmod +x MCP-Connector-…-x86_64.AppImage
  ./MCP-Connector-…-x86_64.AppImage
  ```

MCP Connector keeps your tokens in the system keyring, so it needs GNOME
Keyring or KWallet, installed and unlocked; GNOME, KDE, Xfce, Cinnamon and
most desktops come with one. If the app says no keyring is available, install
or unlock one, then restart MCP Connector. On a desktop it doesn't recognize,
such as i3 or Sway, start it with `--password-store=gnome-libsecret` to use
GNOME Keyring.

Its settings, database and logs are in `~/.config/@mcp-connector/desktop`.

## Set it up

1. In MCP Connector, choose the folder agents may read, connect the services
   you want, and click **Start MCP server**.
2. Under **Copy the setup for your agent**, copy the setup for Claude Code,
   Cursor, VS Code (Copilot), Codex, Gemini CLI or Windsurf, and put it where
   the app says.

To teach your agent how to use MCP Connector, also add the skill: download
`mcp-connector-skill.zip` and unzip it into your agent's skills folder (for
Claude Code, `%USERPROFILE%\.claude\skills` on Windows, `~/.claude/skills` on
Linux).

## The Linux AppImage

The AppImage needs FUSE 2. On Ubuntu 24.04 and newer, install it with
`sudo apt install libfuse2t64`; on Ubuntu 22.04, with `sudo apt install libfuse2`.

**Ubuntu 23.10 and newer, including 24.04 LTS,** restrict the user namespaces that MCP Connector's
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

If you set up an agent with **Copy stdio setup**, the setup points at the
AppImage file, so keep it where it was when you copied the setup.

## Also attached

- `mcp-connector-vscode-….vsix`: the optional VS Code extension that shares
  your active editor with MCP Connector.

## Known limits

- Notion sign-in isn't available yet; it comes in a later release. GitHub
  sign-in and the other MCP servers you add work now.
- No automatic updates yet: download new versions from this page.
- MCP servers you add with `npx` need Node.js installed.
