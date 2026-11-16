# MCP Connector for web chats (Chrome extension)

Part of MCP Connector, released under the MIT License (see LICENSE).

This extension lets a chat on chatgpt.com ask for the tools in your MCP
Connector app. You decide which tools a chat may use, you run each request
yourself, and whatever needs approval still waits for you in the MCP Connector
window. It works with ChatGPT only, in Chrome 116 or newer.

## Install from the folder

1. Build the extension, from the repository root:

   ```powershell
   npm install
   npm run build:chrome
   ```

   This writes the extension to `apps/chrome-extension/dist`.
   `npm run package:chrome` also writes
   `release/mcp-connector-chrome-<version>.zip`; unzip it to get the same folder.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `apps/chrome-extension/dist` folder.
   The extension's options page opens.
4. In the MCP Connector app, click **Start MCP server**. Under **Web chats**,
   click **Create key**, then **Copy**.
5. In the options page, paste the key, check the port (47820 unless you
   changed it; the app shows it next to the key), and click **Save and test**.
   The page says one of:
   - **Connected**, with the number of tools.
   - **MCP Connector is not running**: open the app and start its MCP server.
     If you do not have the app, the page links to its
     [Releases](https://github.com/qwaziestatic/MCP-connector/releases).
   - **MCP Connector refused the browser key**: copy the key again from the app.
6. Reload any ChatGPT tab that was already open.

After you rebuild, click the reload arrow on the extension's card in
`chrome://extensions`.

## Use it

1. Open a chat on chatgpt.com and click the extension's icon. The side panel
   opens and lists your tools.
2. Tick the tools this chat may use. None are ticked to begin with. Ticks
   belong to one chat in one tab, and are forgotten when you open another
   chat there or close the browser.
3. Click **Insert instructions**. A short message appears in the chat box
   that describes only the ticked tools and the request format. Read it and
   press Send.
4. When the chat wants a tool, it writes a request:

   ````
   ```mcp-call
   {"tool": "filesystem_inspect_workspace", "arguments": {}}
   ```
   ````

   The request is outlined in the page and appears in the side panel with its
   tool and arguments. A request for a tool you did not tick is refused, and
   the panel says why.
5. Click **Run** in the side panel. Nothing runs before that click.
   - If MCP Connector answers at once, the result is shown.
   - If the request needs approval, the panel says **Waiting for your approval
     in MCP Connector**. Approve or reject it in the app. Once approved, the
     extension runs it, once, and shows the result. If you reject it, or it
     fails, the panel says so. Keep the panel open while it waits.
6. Click **Put result in chat box**. The result appears in the chat box as a
   block labelled `mcp-result`. A result longer than 20,000 characters is cut
   off there, and a note after the block tells the chat that the text is
   incomplete and to ask again for less, for a file with `startLine` and
   `maxLines`. Read it and press Send.

If the page cannot be read, for example after ChatGPT changes its layout, the
panel says so and still works by hand: copy the `mcp-call` block from the
chat into **Paste a request**, and use **Copy result** to paste the answer
back.

## Privacy

What leaves this extension, and where it goes:

- **To MCP Connector on this computer, and nowhere else by itself.** The
  background worker sends requests to `http://127.0.0.1:<port>/mcp`: the list
  of tools, each request you run (the tool's name and its arguments), status
  checks while a request waits, and the run of an approved request. Each
  carries the browser key in its `Authorization` header. These requests never
  leave your computer. The extension's content security policy lets it
  connect to `127.0.0.1` and to nothing else.
- **To ChatGPT, only through the chat box, and only when you press Send.**
  The extension puts two kinds of text in the chat box: the instructions
  (the names, descriptions and argument formats of the tools you ticked) and
  the results you choose to put there. Nothing is sent until you press Send;
  then it goes to OpenAI like anything else you type. A result can contain
  what the tool read, such as file names or file contents, so read it first.
- **Nowhere else.** There is no analytics, telemetry or crash reporting, no
  server of ours, and no code loaded from the network. The link to MCP
  Connector's Releases page opens github.com only if you click it.

What it reads and keeps:

- On chatgpt.com, the content script reads the newest reply to find
  `mcp-call` blocks, and the page's address to tell chats apart. It passes
  these to the side panel only. It does not read your other chats, and it
  runs on no other site.
- The browser key and the port are kept in this browser profile
  (`chrome.storage.local`), which Chrome does not sync and does not encrypt.
  Content scripts, and so the ChatGPT page, cannot read them. Anyone who can
  read your browser profile's files can read the key; click **Turn off** or
  **New key** in MCP Connector to make an old key useless.
- Ticks and requests that are waiting are kept in memory until the browser
  closes.

What MCP Connector records about these requests is described in the
repository's README, under Privacy.

## How it is kept safe

- The browser key lives in the background worker. The content script, which
  runs inside the ChatGPT page, never has it.
- The worker answers only the extension's own pages: the side panel and the
  options page. Messages from the content script are not answered, and web
  pages cannot message the extension at all. So nothing the ChatGPT page does
  can run a tool; a request runs when you click **Run** in the side panel.
- The worker checks every request itself: the tool must be ticked for that
  chat. It follows and finishes only the previews its own requests created,
  and finishes one with the tool MCP Connector names in `executeTool`.
- Requests found in the page are read as plain text and shown as text.
- MCP Connector marks everything the extension asks for as coming from a web
  chat, and by default asks you before a web chat reads anything.

## Development

```powershell
npm run typecheck
npm test --workspace=apps/chrome-extension
npm run build:chrome
```

- `src/lib` holds the logic and its tests: reading requests (`request.ts`),
  the approval steps (`approval.ts`), results (`result.ts`), the client for
  MCP Connector's server (`mcp-client.ts`) and what the worker allows
  (`worker.ts`). `client.test.ts` and `worker.test.ts` run against MCP
  Connector's real HTTP server from `packages/core`: it answers `tools/list`
  and `tools/call` from one plain POST each, with no `initialize` step, as an
  event stream holding one message.
- `src/selectors.ts` holds everything the extension knows about the ChatGPT
  page. When ChatGPT changes its page, that is the file to fix.
- `src/structure.test.ts` checks the manifest's permissions and what each
  built script contains, for example that only the worker makes requests.
- The tests use Node's own test runner, so the extension adds one
  development dependency to the repository: `@types/chrome`, the type
  definitions for Chrome's extension API.
