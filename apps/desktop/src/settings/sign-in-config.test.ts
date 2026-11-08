import { describe, expect, it } from "vitest";
import { hasNotionSignInUrl, readGitHubClientId, readNotionSignInUrl } from "./sign-in-config";

const builtIn = { githubClientId: "Ov23li-built", notionSignInUrl: "https://sign-in.example.workers.dev/" };

describe("sign-in config", () => {
  it("uses the values built into the app", () => {
    expect(readGitHubClientId({}, builtIn)).toBe("Ov23li-built");
    expect(readNotionSignInUrl({}, builtIn)).toBe("https://sign-in.example.workers.dev");
  });

  it("lets the environment override them", () => {
    const env = { MCP_GITHUB_CLIENT_ID: " Ov23li-env ", MCP_NOTION_SIGN_IN_URL: "http://127.0.0.1:8787" };
    expect(readGitHubClientId(env, builtIn)).toBe("Ov23li-env");
    expect(readNotionSignInUrl(env, builtIn)).toBe("http://127.0.0.1:8787");
  });

  it("explains a build without sign-in settings", () => {
    expect(() => readGitHubClientId({ MCP_GITHUB_CLIENT_ID: "  " }, { githubClientId: "" })).toThrow("GitHub sign-in is not set up");
    expect(() => readNotionSignInUrl({}, undefined)).toThrow("Notion sign-in is not set up");
  });

  it("says whether Notion sign-in is built in or set by the environment", () => {
    expect(hasNotionSignInUrl({}, builtIn)).toBe(true);
    expect(hasNotionSignInUrl({ MCP_NOTION_SIGN_IN_URL: "http://127.0.0.1:8787" }, undefined)).toBe(true);
    expect(hasNotionSignInUrl({ MCP_NOTION_SIGN_IN_URL: " " }, { notionSignInUrl: "" })).toBe(false);
    expect(hasNotionSignInUrl({}, undefined)).toBe(false);
  });

  it("refuses a Notion sign-in address that is not https", () => {
    expect(() => readNotionSignInUrl({ MCP_NOTION_SIGN_IN_URL: "http://example.com" }, undefined)).toThrow("https://");
    expect(() => readNotionSignInUrl({ MCP_NOTION_SIGN_IN_URL: "not a url" }, undefined)).toThrow("not a valid URL");
  });
});
