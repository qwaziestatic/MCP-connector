# Setting up MCP Connector

MCP Connector runs on Windows and Linux (64-bit).

1. Install MCP Connector from
   [its releases](https://github.com/qwaziestatic/MCP-connector/releases) and
   open it:
   - **Windows**: run the `.exe` installer.
   - **Ubuntu, Debian and their derivatives**: install the `.deb` with
     `sudo apt install ./MCP-Connector-<version>-amd64.deb`, then open
     MCP Connector from the apps menu.
   - **Other Linux distributions**: make the AppImage executable with
     `chmod +x MCP-Connector-<version>-x86_64.AppImage` and run it. It needs
     FUSE 2 (`libfuse2t64` on Ubuntu 24.04 and newer). On Ubuntu 23.10 and
     newer, use the `.deb`, or add the AppArmor profile from the release notes.
2. Click **Choose workspace** and pick the folder agents may read.
3. Under **Secure provider connections**, click **Connect** next to each
   service you want to use. For Notion, also paste the link of the database
   new pages should go to.
4. Click **Start MCP server**. The address and token stay the same after
   restarts, so this is done once.
5. Under **Copy the setup for your agent**, click your agent's button and put
   the copied setup where it belongs:

| Agent | Where the copied setup goes |
| --- | --- |
| Claude Code | Run the command in a terminal. |
| Cursor | Add the entry to `~/.cursor/mcp.json`. |
| VS Code (GitHub Copilot) | Run **MCP: Open User Configuration** and add the entry. |
| Codex | Add the table to `~/.codex/config.toml`. |
| Gemini CLI | Run the command in a terminal. |
| Windsurf | Add the entry to its `mcp_config.json`, from Cascade's MCP settings. |

Agents that support only stdio can use **Copy stdio setup for Claude Code** or
**Copy stdio JSON** in the installed app instead. It starts MCP Connector in relay mode, so the app must stay open
with its MCP server running. With the AppImage, the setup points at the
AppImage file: keep it where it was when you copied the setup.

The copied setup contains a token. Keep the file private, and click **New
token** in the app if it leaks; then set up each agent again.

## On Linux: the keyring

MCP Connector keeps its tokens in the system keyring, GNOME Keyring or
KWallet, and stores none without one. If it says no keyring is available,
install or unlock GNOME Keyring or KWallet, then restart the app. On a desktop
it doesn't recognize, such as i3 or Sway, start it with
`--password-store=gnome-libsecret` to use GNOME Keyring. Its settings,
database and logs are in `~/.config/@mcp-connector/desktop`.
