// `MCP Connector.exe --mcp-stdio` runs without a window and relays an agent's
// stdio messages to the copy of MCP Connector that is already running.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
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

export interface RelayProfile {
  /** The running app's data folder, which this process only reads. */
  readonly appDataPath: string;
  readonly vaultKeyAvailable: boolean;
}

/**
 * Copies the vault's encryption key, and nothing else, into another Local State
 * file. Returns false if the source has no key yet.
 */
export function copyVaultKey(fromPath: string, toPath: string): boolean {
  let osCrypt: unknown;
  try {
    osCrypt = (JSON.parse(readFileSync(fromPath, "utf8")) as { os_crypt?: unknown }).os_crypt;
  } catch {
    osCrypt = undefined;
  }
  writeFileSync(toPath, JSON.stringify(osCrypt === undefined ? {} : { os_crypt: osCrypt }));
  return osCrypt !== undefined;
}

/**
 * Keeps this process out of the app's Chromium profile. Chromium rewrites Local
 * State when it exits, and on Windows that file holds the key protecting the
 * vault: a relay that found no key would make its own and could save it over
 * the real one, locking the app out of its vault. Must run before the app is
 * ready, when Chromium opens the profile. Elsewhere the key is in the OS keychain.
 */
export function useRelayProfile(): RelayProfile {
  const appDataPath = app.getPath("userData");
  if (process.platform !== "win32") return { appDataPath, vaultKeyAvailable: true };
  const relayPath = join(appDataPath, "stdio-relay");
  mkdirSync(relayPath, { recursive: true });
  const vaultKeyAvailable = copyVaultKey(join(appDataPath, "Local State"), join(relayPath, "Local State"));
  app.setPath("userData", relayPath);
  return { appDataPath, vaultKeyAvailable };
}

async function readConnection(profile: RelayProfile): Promise<{ url: string | null; bearerToken: string }> {
  // A new profile's key reaches the disk about ten seconds after the first
  // launch. Until then the agent is told to try again.
  const url = profile.vaultKeyAvailable
    ? await readMcpEndpoint(join(profile.appDataPath, "mcp-endpoint.json"))
    : null;
  if (url === null) return { url, bearerToken: "" };
  try {
    const vault = new CredentialVault(join(profile.appDataPath, "credentials.json"));
    return { url, bearerToken: (await vault.getSecret("mcp-http-token")) ?? "" };
  } catch (error) {
    process.stderr.write(`Could not read the MCP token: ${error instanceof Error ? error.message : String(error)}\n`);
    return { url: null, bearerToken: "" };
  }
}

export async function runStdioMode(profile: RelayProfile): Promise<void> {
  // stdout carries the protocol, so anything else must go to stderr.
  console.log = console.error;
  console.info = console.error;
  const { url, bearerToken } = await readConnection(profile);
  await runStdioBridge({
    url,
    bearerToken,
    input: openStdin(),
    log: (message) => process.stderr.write(`${message}\n`)
  });
  app.quit();
}
