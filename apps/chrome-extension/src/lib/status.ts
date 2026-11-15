// What the panel and the options page say about the connection to MCP Connector.
import type { ConnectionStatus } from "./worker.ts";

export interface StatusLine {
  readonly ok: boolean;
  readonly text: string;
  /** What helps: the options page, the app's download page, or checking again. */
  readonly actions: ReadonlyArray<"options" | "releases" | "retry">;
}

export function describeStatus(status: ConnectionStatus): StatusLine {
  switch (status.state) {
    case "connected":
      return {
        ok: true,
        text: `Connected to MCP Connector on port ${status.port}. ${status.tools.length} ${status.tools.length === 1 ? "tool" : "tools"} available.`,
        actions: ["retry"]
      };
    case "not-paired":
      return {
        ok: false,
        text: "Not set up yet. In MCP Connector, under Web chats, create a key, then paste it in this extension's options.",
        actions: ["options", "releases"]
      };
    case "app-not-running":
      return {
        ok: false,
        text: `MCP Connector is not running, or its MCP server is stopped. Open the app and click Start MCP server. If you do not have the app yet, install it from its Releases page.`,
        actions: ["retry", "releases"]
      };
    case "wrong-key":
      return {
        ok: false,
        text: "MCP Connector refused the browser key. Copy the key again from the app, under Web chats, and paste it in the options. If web chats are turned off there, create a new key.",
        actions: ["options", "retry"]
      };
    case "not-mcp-connector":
      return {
        ok: false,
        text: `Something is answering on port ${status.port}, but it is not MCP Connector. Check the port in the options: the app shows it under Web chats.`,
        actions: ["options", "retry"]
      };
    case "timeout":
      return { ok: false, text: "MCP Connector did not answer in time. Check that the app is still open.", actions: ["retry"] };
    case "error":
      return { ok: false, text: `MCP Connector reported a problem: ${status.message}`, actions: ["retry"] };
  }
}
