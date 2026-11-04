---
name: mcp-connector
description: Work with the user's local project folder, GitHub, and Notion through the MCP Connector desktop app, where every change waits for the user's approval. Use when the user asks you to look at their selected workspace, list their GitHub repositories, or write something to Notion, or when tools from the "mcp-connector" MCP server are available.
---

# MCP Connector

MCP Connector is a Windows desktop app that gives you tools over MCP. It shows
you only the folder the user chose, and it never changes anything for you
without the user's explicit approval in its window. Follow these rules exactly.

## Before you start

- The tools come from an MCP server named `mcp-connector`. If you do not have
  them, the app is not set up for you yet: point the user to
  [references/setup.md](references/setup.md) and stop.
- If a tool says the MCP server is not running, ask the user to open
  MCP Connector and click **Start MCP server**.

## Reading the user's workspace

1. Call `workspace_get_selected` first.
2. If no workspace is selected, ask the user to choose a folder in
   MCP Connector. Do not guess paths.
3. Call `filesystem_inspect_workspace` without a path for the whole folder, or
   with a path relative to it for a subfolder. Paths outside the folder are
   refused; do not try to get around that.

## Changes need the user's approval

Tools that change something come in two steps: a **preview** tool, and an
**execute** tool that only works after the user approves the preview in the
app. The steps are always:

1. Call the preview tool. It changes nothing.
2. Tell the user, in one or two sentences, what is waiting and that they
   approve or reject it in the MCP Connector window. The app shows a
   notification.
3. Call `workflow_preview_status` with the preview's `previewId`, about every
   10 seconds, for up to 5 minutes. Or ask the user to tell you when done.
   - `APPROVED`: call the execute tool **once** with the same `previewId`.
   - `REJECTED`: stop. Do not make the same preview again unless the user asks.
   - `PREVIEWED` after 5 minutes: stop polling and tell the user it is still
     waiting.
4. Say a change happened only after the execute tool returns success. If it
   fails, report its message; do not retry on your own.

You cannot approve anything yourself, and you must not ask the user to approve
something they have not seen in the app.

## Services

Each service is connected in the app, under **Secure provider connections**.

- **GitHub**: `github_list_repositories` lists the repositories the user's
  account can reach; pass `name` to filter.
- **Notion**: `notion_create_project_page_preview` previews a new page from a
  title and Markdown, then `notion_create_project_page` creates it once
  approved. Pages go to the database the user chose in the app.

If a tool says a service is not connected, or needs a setting, pass its
message on: the user fixes both in the app, next to the service.

All tools and their inputs are in [references/tools.md](references/tools.md).
