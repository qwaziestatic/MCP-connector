import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startVsCodeContextServer } from "./vscode-context-server";

function waitForMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(data.toString()));
    socket.once("error", reject);
  });
}

describe("VS Code context server", () => {
  it("requires the bearer token and accepts validated context", async () => {
    let receivedWorkspace: string | null = null;
    const server = await startVsCodeContextServer((context) => {
      receivedWorkspace = context.workspacePath;
    });

    const unauthorized = new WebSocket(server.url);
    await expect(new Promise<void>((resolve, reject) => {
      unauthorized.once("close", () => resolve());
      unauthorized.once("error", () => resolve());
    })).resolves.toBeUndefined();

    const socket = new WebSocket(server.url, {
      headers: { Authorization: `Bearer ${server.bearerToken}` }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({
      type: "vscode.context",
      workspacePath: "C:\\workspace",
      languageId: "typescript"
    }));
    await expect(waitForMessage(socket)).resolves.toBe('{"type":"vscode.context.accepted"}');
    expect(receivedWorkspace).toBe("C:\\workspace");
    expect(server.latestContext?.languageId).toBe("typescript");

    socket.close();
    await server.close();
  });

  it("rejects invalid context without invoking the callback", async () => {
    let callbackCalled = false;
    const server = await startVsCodeContextServer(() => {
      callbackCalled = true;
    });
    const socket = new WebSocket(server.url, {
      headers: { Authorization: `Bearer ${server.bearerToken}` }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "vscode.context", workspacePath: "" }));
    await expect(waitForMessage(socket)).resolves.toBe('{"type":"vscode.context.rejected","reason":"Invalid context payload."}');
    expect(callbackCalled).toBe(false);
    socket.close();
    await server.close();
  });
});
