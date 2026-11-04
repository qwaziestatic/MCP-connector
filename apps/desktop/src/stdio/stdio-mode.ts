// `MCP Connector.exe --mcp-stdio` runs without a window and relays an agent's
// stdio messages to the copy of MCP Connector that is already running.
import { readFile } from "node:fs/promises";
import { Socket } from "node:net";
import type { Readable } from "node:stream";
import { app } from "electron";
import { runStdioBridge } from "@mcp-connector/core";
import { CredentialVault } from "../security/credential-vault";
import type { McpEndpointFile } from "../connection/connection-manager";

export const STDIO_FLAG = "--mcp-stdio";

export function isStdioMode(argv: readonly string[] = process.argv): boolean {
  return argv.includes(STDIO_FLAG);
}

/** The running server's address, or null if the app says nothing is running. */
export async function readMcpEndpoint(endpointFilePath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(endpointFilePath, "utf8")) as Partial<McpEndpointFile>;
    return typeof parsed.url === "string" ? parsed.url : null;
  } catch {
    return null;
  }
}

/**
 * On Windows, Electron replaces process.stdin in the main process with a stream
 * that is already at end of file, so the real stdin is opened by its descriptor.
 */
function openStdin(): Readable {
  return process.platform === "win32"
    ? new Socket({ fd: 0, readable: true, writable: false })
    : process.stdin;
}

export async function runStdioMode(endpointFilePath: string): Promise<void> {
  // stdout carries the protocol, so anything else must go to stderr.
  console.log = console.error;
  console.info = console.error;
  const url = await readMcpEndpoint(endpointFilePath);
  const bearerToken = url === null ? "" : (await new CredentialVault().getSecret("mcp-http-token")) ?? "";
  await runStdioBridge({
    url,
    bearerToken,
    input: openStdin(),
    log: (message) => process.stderr.write(`${message}\n`)
  });
  app.quit();
}
