import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_DEVICE_GRANT_TYPE,
  GitHubDeviceFlow
} from "./github-device-flow.js";

const deviceCode = {
  device_code: "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5
};

/** A fake GitHub: answers the device-code request, then each poll in turn. */
function fakeGitHub(polls: Array<Record<string, unknown>>) {
  const requests: Array<{ url: string; body: Record<string, string> }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
    requests.push({ url: String(url), body });
    const answer = String(url) === GITHUB_DEVICE_CODE_URL ? deviceCode : polls.shift() ?? { error: "authorization_pending" };
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
  const waits: number[] = [];
  let clock = 1_000_000;
  const flow = new GitHubDeviceFlow("client-123", ["read:user", "repo"], {
    fetch: fetchMock,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
    now: () => clock
  });
  return { flow, requests, waits };
}

describe("GitHubDeviceFlow", () => {
  it("gets a code without sending a client secret", async () => {
    const { flow, requests } = fakeGitHub([]);
    const authorization = await flow.start();

    expect(authorization).toMatchObject({ userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", interval: 5 });
    expect(requests[0]).toEqual({ url: GITHUB_DEVICE_CODE_URL, body: { client_id: "client-123", scope: "read:user repo" } });
  });

  it("waits while the user enters the code, then returns the token", async () => {
    const { flow, requests, waits } = fakeGitHub([
      { error: "authorization_pending" },
      { error: "authorization_pending" },
      { access_token: "gho_token", token_type: "bearer", scope: "read:user,repo" }
    ]);
    const token = await flow.waitForToken(await flow.start());

    expect(token).toEqual({ accessToken: "gho_token", refreshToken: null, expiresAt: null, tokenType: "bearer", scope: "read:user,repo" });
    expect(waits).toEqual([5000, 5000, 5000]);
    expect(requests.at(-1)).toEqual({
      url: GITHUB_ACCESS_TOKEN_URL,
      body: { client_id: "client-123", device_code: deviceCode.device_code, grant_type: GITHUB_DEVICE_GRANT_TYPE }
    });
    expect(requests.every((request) => !("client_secret" in request.body))).toBe(true);
  });

  it("polls more slowly when GitHub says slow_down", async () => {
    const { flow, waits } = fakeGitHub([
      { error: "slow_down" },
      { error: "slow_down", interval: 20 },
      { access_token: "gho_token" }
    ]);
    await flow.waitForToken(await flow.start());

    expect(waits).toEqual([5000, 10_000, 20_000]);
  });

  it.each([
    [{ error: "access_denied" }, "declined"],
    [{ error: "expired_token" }, "expired before it was entered"],
    [{ error: "device_flow_disabled" }, "Enable Device Flow"],
    [{ error: "incorrect_client_credentials", error_description: "bad id" }, "GitHub sign-in failed"]
  ])("explains %o", async (answer, message) => {
    const { flow } = fakeGitHub([answer]);
    await expect(flow.waitForToken(await flow.start())).rejects.toThrow(message);
  });

  it("stops when the code expires on the client side", async () => {
    const { flow } = fakeGitHub([]);
    const authorization = { ...(await flow.start()), expiresAt: new Date(1_000_000 + 12_000).toISOString() };

    await expect(flow.waitForToken(authorization)).rejects.toThrow("expired before it was entered");
  });

  it("returns the expiry and refresh token when the OAuth app's tokens expire", async () => {
    const { flow } = fakeGitHub([
      { access_token: "ghu_token", token_type: "bearer", scope: "", expires_in: 28_800, refresh_token: "ghr_refresh", refresh_token_expires_in: 15_811_200 }
    ]);
    const token = await flow.waitForToken(await flow.start());

    // The clock had moved on by one poll interval.
    expect(token).toMatchObject({ accessToken: "ghu_token", refreshToken: "ghr_refresh" });
    expect(token.expiresAt).toBe(new Date(1_000_000 + 5000 + 28_800_000).toISOString());
  });

  it("renews an expiring token without a client secret", async () => {
    const { flow, requests } = fakeGitHub([
      { access_token: "ghu_new", token_type: "bearer", expires_in: 28_800, refresh_token: "ghr_new" }
    ]);

    await expect(flow.refresh("ghr_old")).resolves.toMatchObject({ accessToken: "ghu_new", refreshToken: "ghr_new" });
    expect(requests).toEqual([{
      url: GITHUB_ACCESS_TOKEN_URL,
      body: { client_id: "client-123", grant_type: "refresh_token", refresh_token: "ghr_old" }
    }]);
  });

  it("keeps the old refresh token if GitHub sends none, and explains a dead one", async () => {
    const kept = fakeGitHub([{ access_token: "ghu_new", expires_in: 28_800 }]);
    await expect(kept.flow.refresh("ghr_old")).resolves.toMatchObject({ refreshToken: "ghr_old" });

    const dead = fakeGitHub([{ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." }]);
    await expect(dead.flow.refresh("ghr_old")).rejects.toThrow("can no longer be renewed");
  });

  it("stops when cancelled", async () => {
    const { flow } = fakeGitHub([]);
    const controller = new AbortController();
    const authorization = await flow.start();
    controller.abort();

    await expect(flow.waitForToken(authorization, controller.signal)).rejects.toThrow("cancelled");
  });
});
