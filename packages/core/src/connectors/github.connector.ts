import { Octokit } from "@octokit/rest";
import type {
  ConnectorTokenProvider,
  GitHubConnector,
  GitHubRepositoryList
} from "./connector.types.js";

export class OctokitGitHubConnector implements GitHubConnector {
  public constructor(private readonly tokenProvider: ConnectorTokenProvider) {}

  async listRepositories(options: { readonly name?: string; readonly limit?: number } = {}): Promise<GitHubRepositoryList> {
    const octokit = new Octokit({
      auth: await this.tokenProvider.getAccessToken()
    });
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 200);

    try {
      const repositories = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
        affiliation: "owner,collaborator,organization_member",
        per_page: 100,
        sort: "updated"
      });

      const filtered = options.name === undefined
        ? repositories
        : repositories.filter((repository) =>
          repository.full_name.toLowerCase().includes(options.name!.toLowerCase()));
      return {
        repositories: filtered.slice(0, limit).map((repository) => ({
          fullName: repository.full_name,
          description: repository.description,
          defaultBranch: repository.default_branch,
          isPrivate: repository.private
        })),
        truncated: filtered.length > limit
      };
    } catch (error) {
      const status = this.getStatus(error);
      if (status === 401) {
        throw new Error("GitHub authorization has expired or was revoked.");
      }
      if (status === 403) {
        throw new Error("GitHub denied the request, possibly due to rate limits or insufficient scope.");
      }
      throw new Error(`GitHub repository request failed${status === null ? "" : ` (${status})`}.`);
    }
  }

  private getStatus(error: unknown): number | null {
    if (typeof error !== "object" || error === null) return null;
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : null;
  }
}
