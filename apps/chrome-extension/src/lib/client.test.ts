// Checks the extension's client against MCP Connector's real HTTP server, the
// way the background worker sends requests: one plain POST each.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { callTool, ConnectionError, listTools, readRpcMessage, type ConnectionProblem } from "./mcp-client.ts";
import { AGENT_TOKEN, BROWSER_KEY, startApp } from "./testing.ts";

async function problemOf(run: Promise<unknown>): Promise<ConnectionProblem | string> {
  try {
    await run;
    return "no problem";
  } catch (error) {
    return error instanceof ConnectionError ? error.problem : `another error: ${String(error)}`;
  }
}

describe("the MCP client against MCP Connector's server", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  before(async () => { app = await startApp(); });
  after(() => app.close());

  it("gets answers to tools/list and tools/call from a plain POST, with no initialize step", async () => {
    const post = (method: string, params: unknown) => fetch(`http://127.0.0.1:${app.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${BROWSER_KEY}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params })
    });

    const listed = await post("tools/list", {});
    assert.equal(listed.status, 200);
    // The server answers with an event stream holding one message; the client reads both forms.
    const contentType = listed.headers.get("content-type") ?? "";
    assert.match(contentType, /text\/event-stream|application\/json/u);
    assert.equal(listed.headers.get("mcp-session-id"), null);
    const list = readRpcMessage(await listed.text(), contentType, 7);
    assert.equal(Array.isArray((list?.result as { tools: unknown[] }).tools), true);

    const called = await post("tools/call", { name: "workflow_preview_status", arguments: { previewId: "6b2c8f2e-1f1e-4c47-9b1a-6f1d2f3e4a5b" } });
    assert.equal(called.status, 200);
    const call = readRpcMessage(await called.text(), called.headers.get("content-type") ?? "", 7);
    assert.equal((call?.result as { isError?: boolean }).isError, true);
  });

  it("lists the tools a web chat gets", async () => {
    const names = (await listTools({ browserKey: BROWSER_KEY, port: app.port })).map((tool) => tool.name);
    for (const name of ["workspace_get_selected", "filesystem_inspect_workspace", "workflow_preview_status", "web_run_approved_read"]) {
      assert.equal(names.includes(name), true, name);
    }
  });

  it("calls a tool and gets MCP Connector's answer", async () => {
    const answer = await callTool({ browserKey: BROWSER_KEY, port: app.port }, "workspace_get_selected", {});
    // A web chat's read waits for approval, so the answer is a preview that names the tool to run it.
    assert.deepEqual(
      [(answer.structuredContent as { requiresApproval: boolean }).requiresApproval, (answer.structuredContent as { executeTool: string }).executeTool],
      [true, "web_run_approved_read"]
    );
    // The agents' token on the same server is answered at once.
    const agent = await callTool({ browserKey: AGENT_TOKEN, port: app.port }, "workspace_get_selected", {});
    assert.equal(typeof (agent.structuredContent as { workspacePath: string }).workspacePath, "string");
  });

  it("reports a tool the server does not have as an error, not as a connection problem", async () => {
    const answer = await callTool({ browserKey: BROWSER_KEY, port: app.port }, "no_such_tool", {}).catch((error: unknown) => error);
    const failed = answer instanceof Error ? !(answer instanceof ConnectionError) : (answer as { isError?: boolean }).isError === true;
    assert.equal(failed, true);
  });

  it("says when the key is wrong, and when web chats are turned off", async () => {
    assert.equal(await problemOf(listTools({ browserKey: "wrong-key-0123456789-abcdefghij", port: app.port })), "wrong-key");
    app.setBrowserKey(null);
    assert.equal(await problemOf(listTools({ browserKey: BROWSER_KEY, port: app.port })), "wrong-key");
    app.setBrowserKey(BROWSER_KEY);
  });

  it("says when the app is not running", async () => {
    const stopped = await startApp();
    await stopped.close();
    assert.equal(await problemOf(listTools({ browserKey: BROWSER_KEY, port: stopped.port })), "app-not-running");
    assert.equal(await problemOf(callTool({ browserKey: BROWSER_KEY, port: stopped.port }, "workspace_get_selected", {})), "app-not-running");
  });

  it("says when something else is using the port", async () => {
    for (const answer of [
      { status: 200, body: "<html>hello</html>", type: "text/html" },
      { status: 404, body: "Not found", type: "text/plain" },
      { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 999_999, result: {} }), type: "application/json" }
    ]) {
      const other = createServer((_request, response) => {
        response.writeHead(answer.status, { "content-type": answer.type }).end(answer.body);
      });
      await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
      try {
        const port = (other.address() as AddressInfo).port;
        assert.equal(await problemOf(listTools({ browserKey: BROWSER_KEY, port })), "not-mcp-connector");
      } finally {
        await new Promise<void>((resolve) => other.close(() => resolve()));
      }
    }
  });

  it("sends the key only in the Authorization header, and nothing of the browser's", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const recording = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return fetch(url, init);
    }) as typeof fetch;
    await listTools({ browserKey: BROWSER_KEY, port: app.port }, { fetch: recording });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, `http://127.0.0.1:${app.port}/mcp`);
    assert.equal(seen[0]!.url.includes(BROWSER_KEY), false);
    assert.equal(String(seen[0]!.init.body).includes(BROWSER_KEY), false);
    assert.equal(new Headers(seen[0]!.init.headers).get("authorization"), `Bearer ${BROWSER_KEY}`);
    assert.equal(seen[0]!.init.credentials, "omit");
    assert.equal(seen[0]!.init.redirect, "error");
  });
});

describe("readRpcMessage", () => {
  const message = { jsonrpc: "2.0", id: 3, result: { tools: [] } };

  it("reads an event stream", () => {
    const stream = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    assert.deepEqual(readRpcMessage(stream, "text/event-stream", 3), message);
    assert.deepEqual(readRpcMessage(stream.replace(/\n/gu, "\r\n"), "text/event-stream; charset=utf-8", 3), message);
    // Other events, and messages for other requests, are passed over.
    const busy = `: ping\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n${stream}`;
    assert.deepEqual(readRpcMessage(busy, "text/event-stream", 3), message);
  });

  it("reads a JSON body, alone or in a batch", () => {
    assert.deepEqual(readRpcMessage(JSON.stringify(message), "application/json", 3), message);
    assert.deepEqual(readRpcMessage(JSON.stringify([{ jsonrpc: "2.0", id: 2, result: {} }, message]), "application/json", 3), message);
  });

  it("returns null when the answer is not there", () => {
    assert.equal(readRpcMessage(JSON.stringify(message), "application/json", 4), null);
    assert.equal(readRpcMessage("<html>", "text/html", 3), null);
    assert.equal(readRpcMessage("data: not json\n\n", "text/event-stream", 3), null);
  });
});
