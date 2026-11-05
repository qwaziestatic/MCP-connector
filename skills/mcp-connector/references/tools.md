# MCP Connector tools

Read-only tools change nothing. Every tool that changes something has a
preview step that the user approves in the MCP Connector window.

## Workspace

| Tool | Input | What it does |
| --- | --- | --- |
| `workspace_get_selected` | none | Returns the folder the user selected, or says none is selected. |
| `filesystem_inspect_workspace` | `workspacePath` (optional) | Lists the files in the selected folder, or a subfolder given relative to it, and reads its README. Refuses anything outside the folder. |

## Approvals

| Tool | Input | What it does |
| --- | --- | --- |
| `workflow_preview_status` | `previewId` | Returns `PREVIEWED` (waiting for the user), `APPROVED` (ready to execute), `REJECTED` (declined), `EXECUTING`, `EXECUTED`, or `FAILED`. |

## GitHub

| Tool | Input | What it does |
| --- | --- | --- |
| `github_list_repositories` | `name` (optional) | Lists repositories the connected account can reach, newest first, with full name, description, default branch, and whether each is private. `name` filters by part of the full name. |

## Notion

| Tool | Input | What it does |
| --- | --- | --- |
| `notion_create_project_page_preview` | `title`, `markdown` | Previews a page for the database the user chose. Changes nothing. Headings, lists, to-dos, quotes, code blocks, and dividers are kept; inline formatting such as **bold** or links becomes plain text. |
| `notion_create_project_page` | `previewId` | Creates the approved page, exactly as previewed. Fails unless the preview is `APPROVED`. |

## Other MCP servers

Servers the user connected appear as `<server>__<tool>`, with that server's
own inputs. Read-only tools run at once; the others return a preview first.

| Tool | Input | What it does |
| --- | --- | --- |
| `external_run_approved_call` | `previewId` | Runs an approved call to another server's tool, exactly as approved, once, and returns that server's result. |

## Messages you may see

| Message contains | What to tell the user |
| --- | --- |
| "No workspace is selected" | Choose a folder in MCP Connector. |
| "outside the user-selected workspace" | Only the selected folder can be read. |
| "is not connected" | Click **Connect** next to the service in MCP Connector. |
| "needs" and a setting's name | Set it in MCP Connector, under the service. |
| "Explicit approval is required" | The preview is not approved yet; keep waiting or ask the user. |
| "already been executed" | Nothing to do; it is done. |
| "is not connected. Ask the user to reconnect it" | Click **Reconnect** next to that server, under **Other MCP servers**. |
