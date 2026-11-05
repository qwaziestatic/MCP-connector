// Other MCP servers the user connects through MCP Connector, and how their
// setup is read from what a server's README usually gives: an "mcpServers"
// JSON block.
import { z } from "zod";

export type ExternalTransport =
  /** A program MCP Connector starts, speaking MCP over its stdin and stdout. */
  | { readonly kind: "stdio"; readonly command: string; readonly args: readonly string[] }
  /** A server reached over streamable HTTP. */
  | { readonly kind: "http"; readonly url: string };

/**
 * "changes": tools the server marks read-only run at once; every other tool
 * waits for approval. "all": every tool waits for approval.
 */
export type ApprovalMode = "changes" | "all";

export interface ExternalServerConfig {
  /** Lowercase id; agents see the server's tools as `<id>__<tool>`. */
  readonly id: string;
  readonly name: string;
  readonly transport: ExternalTransport;
  readonly approval: ApprovalMode;
}

/** Values that may hold keys or tokens. The app keeps them in its vault, never in settings.json. */
export interface ExternalServerSecrets {
  /** Environment variables for a stdio server. */
  readonly env: Readonly<Record<string, string>>;
  /** Request headers for an HTTP server. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface ParsedServerSetup {
  readonly config: ExternalServerConfig;
  readonly secrets: ExternalServerSecrets;
}

export const EXTERNAL_SERVER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const externalServerConfigSchema = z.object({
  id: z.string().regex(EXTERNAL_SERVER_ID_PATTERN),
  name: z.string().min(1).max(100),
  transport: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("stdio"), command: z.string().min(1), args: z.array(z.string()).readonly() }),
    z.object({ kind: z.literal("http"), url: z.string().url() })
  ]),
  approval: z.enum(["changes", "all"])
});

export const externalServerSecretsSchema = z.object({
  env: z.record(z.string(), z.string()),
  headers: z.record(z.string(), z.string())
});

const stringRecord = z.record(z.string(), z.string());

const entrySchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: stringRecord.optional(),
  url: z.string().optional(),
  serverUrl: z.string().optional(),
  httpUrl: z.string().optional(),
  headers: stringRecord.optional(),
  type: z.string().optional(),
  transport: z.string().optional()
});

const HOW_TO = 'Paste the "mcpServers" block from the server\'s README, for example '
  + '{"mcpServers": {"files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Projects"]}}}.';

/** Turns a server's name into an id agents can use in tool names. */
export function toServerId(name: string, taken: ReadonlySet<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(base)) base = `server-${base}`.replace(/-+$/, "");
  base = base.slice(0, 28).replace(/-+$/, "") || "server";
  let id = base;
  for (let number = 2; taken.has(id); number += 1) id = `${base}-${number}`;
  return id;
}

function entriesOf(value: unknown): readonly [string, unknown][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`That is not a server setup. ${HOW_TO}`);
  }
  const object = value as Record<string, unknown>;
  for (const key of ["mcpServers", "servers", "mcp_servers"]) {
    const nested = object[key];
    if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
      return Object.entries(nested);
    }
  }
  if ("command" in object || "url" in object || "serverUrl" in object || "httpUrl" in object) {
    throw new Error(`Give the server a name: {"mcpServers": {"my-server": ${JSON.stringify(object)}}}.`);
  }
  return Object.entries(object);
}

/**
 * Reads one or more servers from pasted JSON. Environment variables and
 * headers come back as secrets, so the caller can keep them out of plain files.
 */
export function parseServerSetup(
  text: string,
  options: { readonly approval?: ApprovalMode; readonly takenIds?: ReadonlySet<string> } = {}
): readonly ParsedServerSetup[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`That is not valid JSON. ${HOW_TO}`);
  }
  const entries = entriesOf(json);
  if (entries.length === 0) throw new Error(`No servers were found. ${HOW_TO}`);

  const taken = new Set(options.takenIds ?? []);
  return entries.map(([name, value]) => {
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success) throw new Error(`The setup for "${name}" is not in the usual format. ${HOW_TO}`);
    const entry = parsed.data;
    const type = (entry.type ?? entry.transport ?? "").toLowerCase();
    const url = entry.httpUrl ?? entry.serverUrl ?? entry.url;
    const id = toServerId(name, taken);
    taken.add(id);
    const approval = options.approval ?? "changes";

    if (entry.command !== undefined && entry.command.trim().length > 0) {
      return {
        config: { id, name, approval, transport: { kind: "stdio", command: entry.command.trim(), args: entry.args ?? [] } },
        secrets: { env: entry.env ?? {}, headers: {} }
      };
    }
    if (url !== undefined) {
      if (type === "sse" || /\/sse\/?$/i.test(url)) {
        throw new Error(`"${name}" uses the older SSE transport, which MCP Connector does not support. Use its streamable HTTP address, usually ending in /mcp.`);
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new Error(`The address for "${name}" is not a valid URL.`);
      }
      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        throw new Error(`The address for "${name}" must start with https:// or http://.`);
      }
      return {
        config: { id, name, approval, transport: { kind: "http", url: parsedUrl.href } },
        secrets: { env: {}, headers: entry.headers ?? {} }
      };
    }
    throw new Error(`The setup for "${name}" has neither a "command" nor a "url". ${HOW_TO}`);
  });
}
