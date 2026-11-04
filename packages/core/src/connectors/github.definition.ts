import { z } from "zod";
import { result } from "../mcp/tool-result.js";
import type { ConnectorDefinition } from "./connector-definition.js";
import type { ConnectorTokenProvider, GitHubConnector } from "./connector.types.js";
import { OctokitGitHubConnector } from "./github.connector.js";

/** What the GitHub tools need: the user's profile and their repositories. */
export const GITHUB_SCOPES = ["read:user", "repo"] as const;

export function createGitHubDefinition(options: {
  /** Replaceable in tests. */
  readonly createConnector?: (tokens: ConnectorTokenProvider) => GitHubConnector;
} = {}): ConnectorDefinition {
  const createConnector = options.createConnector ?? ((tokens) => new OctokitGitHubConnector(tokens));
  return {
    id: "github",
    name: "GitHub",
    description: "Lets agents list the repositories your account can reach.",
    signIn: { kind: "github-device-flow", scopes: GITHUB_SCOPES },
    settings: [],
    registerTools(server, { runtime }) {
      server.registerTool(
        "github_list_repositories",
        {
          title: "List GitHub repositories",
          description: "List repositories accessible to the connected GitHub account.",
          inputSchema: {
            name: z.string().trim().min(1).max(200).optional()
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: true
          }
        },
        async ({ name }) => result(await createConnector(runtime.tokens).listRepositories(
          name === undefined ? {} : { name }
        ))
      );
    }
  };
}
