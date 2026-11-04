import { describe, expect, it, vi } from "vitest";
import { NotionSignInClient } from "./notion-sign-in.client.js";

function service(status: number, answer: unknown) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(typeof answer === "string" ? answer : JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  return { client: new NotionSignInClient("https://sign-in.example.workers.dev/", fetchImpl), requests };
}

describe("NotionSignInClient", () => {
  it("builds the start link with the app's port and state", () => {
    const { client } = service(200, {});
    expect(client.authorizationUrl(53682, "state-123"))
      .toBe("https://sign-in.example.workers.dev/notion/start?port=53682&state=state-123");
  });

  it("exchanges a code through the service", async () => {
    const { client, requests } = service(200, {
      access_token: "ntn_token",
      token_type: "bearer",
      refresh_token: "nrt_1",
      workspace_name: "Team space"
    });

    await expect(client.exchangeCode("abc")).resolves.toEqual({
      token: { accessToken: "ntn_token", refreshToken: "nrt_1", expiresAt: null, tokenType: "bearer", scope: null },
      workspaceName: "Team space"
    });
    expect(requests).toEqual([{ url: "https://sign-in.example.workers.dev/notion/token", body: { code: "abc" } }]);
  });

  it("keeps the old refresh token when Notion does not send a new one", async () => {
    const { client, requests } = service(200, { access_token: "ntn_new", token_type: "bearer", refresh_token: null });

    await expect(client.refresh("nrt_old")).resolves.toMatchObject({ accessToken: "ntn_new", refreshToken: "nrt_old" });
    expect(requests[0]).toEqual({ url: "https://sign-in.example.workers.dev/notion/refresh", body: { refresh_token: "nrt_old" } });
  });

  it("explains Notion's errors", async () => {
    const { client } = service(400, { object: "error", status: 400, code: "invalid_grant", message: "Invalid code." });
    await expect(client.exchangeCode("used")).rejects.toThrow("Notion sign-in failed: The authorization is no longer valid");
  });

  it("explains the service's own errors", async () => {
    const { client } = service(500, { error: "server_error", error_description: "The sign-in service is missing NOTION_CLIENT_SECRET." });
    await expect(client.exchangeCode("abc")).rejects.toThrow(
      /^Notion sign-in failed: The sign-in service is missing NOTION_CLIENT_SECRET\.$/
    );
  });

  it("says when the service cannot be reached or answers oddly", async () => {
    const offline = new NotionSignInClient("https://sign-in.example.workers.dev", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await expect(offline.exchangeCode("abc")).rejects.toThrow("Could not reach the Notion sign-in service");

    const { client } = service(502, "<html>Bad gateway</html>");
    await expect(client.exchangeCode("abc")).rejects.toThrow("unexpected response (502)");
  });
});
