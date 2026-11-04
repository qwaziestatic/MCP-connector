import { assertValidConnectors, type ConnectorDefinition } from "./connector-definition.js";
import { createGitHubDefinition } from "./github.definition.js";
import { createNotionDefinition } from "./notion.definition.js";

/** Every service MCP Connector ships with, in the order the app lists them. */
export function createBuiltInConnectors(): readonly ConnectorDefinition[] {
  const connectors = [createGitHubDefinition(), createNotionDefinition()];
  assertValidConnectors(connectors);
  return connectors;
}
