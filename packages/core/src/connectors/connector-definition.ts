// A connector is one service an agent can reach through MCP Connector. Each
// one is described by a ConnectorDefinition: its name, how it signs in, the
// settings it needs, and the MCP tools it adds. The desktop app, its vault,
// its connections card, and the MCP server all work from the list of
// definitions, so adding a service means adding one definition.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowService } from "../workflow/workflow.service.js";
import type { WorkflowPreview } from "../workflow/workflow.types.js";
import type { ConnectorTokenProvider } from "./connector.types.js";

/** How a service signs in. The desktop app has one sign-in flow per kind. */
export type ConnectorSignIn =
  /** A short code the user enters on the service's site; no client secret. */
  | { readonly kind: "github-device-flow"; readonly scopes: readonly string[] }
  /** The browser, through the sign-in service that keeps the client secret. */
  | { readonly kind: "notion-sign-in-service" };

export interface ConnectorSetting {
  /** Stable key, stored in the app's settings. */
  readonly key: string;
  readonly label: string;
  /** One or two sentences shown under the field. */
  readonly help: string;
  readonly placeholder: string;
  /** Turns what the user typed into the stored value, or throws a message written for them. */
  readonly parse: (input: string) => string;
}

/**
 * How a connector's tools reach the service. Everything is read when a tool
 * runs, so signing in or changing a setting reaches a server that is already
 * running.
 */
export interface ConnectorRuntime {
  readonly tokens: ConnectorTokenProvider;
  /** A setting's value; throws a message saying where to set it when it is missing. */
  requireSetting(key: string): string;
}

export interface ConnectorToolContext {
  readonly runtime: ConnectorRuntime;
  readonly workflow: WorkflowService;
}

/** Runs the approved previews a connector created. */
export interface ConnectorPreviewExecutor {
  handles(preview: WorkflowPreview): boolean;
  /**
   * Resolves the sign-in and settings, then returns the function that runs
   * the preview. It runs before the approval is used, so a missing setting or
   * sign-in does not use up the user's approval.
   */
  prepare(runtime: ConnectorRuntime): Promise<(preview: WorkflowPreview) => Promise<unknown>>;
}

export interface ConnectorDefinition {
  /** Lowercase id, for example "github". Used in the vault and settings. */
  readonly id: string;
  readonly name: string;
  /** What agents can do with it, shown in the app. */
  readonly description: string;
  readonly signIn: ConnectorSignIn;
  readonly settings: readonly ConnectorSetting[];
  readonly previews?: ConnectorPreviewExecutor;
  registerTools(server: McpServer, context: ConnectorToolContext): void;
}

/** A definition with the runtime the app built for it. */
export interface ConnectedConnector {
  readonly definition: ConnectorDefinition;
  readonly runtime: ConnectorRuntime;
}

const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function isConnectorId(value: unknown): value is string {
  return typeof value === "string" && CONNECTOR_ID_PATTERN.test(value);
}

/** Checks a list of definitions once, when the app starts. */
export function assertValidConnectors(definitions: readonly ConnectorDefinition[]): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (!isConnectorId(definition.id)) throw new Error(`Connector id "${definition.id}" is not valid.`);
    if (seen.has(definition.id)) throw new Error(`Connector id "${definition.id}" is used twice.`);
    seen.add(definition.id);
    const keys = new Set<string>();
    for (const setting of definition.settings) {
      if (keys.has(setting.key)) throw new Error(`${definition.name} has the setting "${setting.key}" twice.`);
      keys.add(setting.key);
    }
  }
}

/**
 * Runs an approved preview with the connector that created it. The connector
 * prepares first, so an unset setting or a missing sign-in is reported
 * without using up the approval.
 */
export async function executeApprovedPreview(
  workflow: WorkflowService,
  connectors: readonly ConnectedConnector[],
  previewId: string
): Promise<unknown> {
  const preview = await workflow.getPreview(previewId);
  const owner = connectors.find((connector) => connector.definition.previews?.handles(preview) === true);
  if (owner?.definition.previews === undefined) {
    throw new Error("No connector in MCP Connector can run this preview.");
  }
  if (await workflow.getStatus(previewId) !== "APPROVED") {
    // executeApproved explains why it cannot run yet, and never calls this.
    return workflow.executeApproved(previewId, () => Promise.reject(new Error("The preview is not approved.")));
  }
  const run = await owner.definition.previews.prepare(owner.runtime);
  return workflow.executeApproved(previewId, run);
}
