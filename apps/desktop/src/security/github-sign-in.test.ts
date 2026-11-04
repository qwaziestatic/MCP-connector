import { describe, expect, it, vi } from "vitest";
import type { GitHubDeviceAuthorization, OAuthTokenSet } from "@mcp-connector/core";
import { GitHubSignIn, type GitHubDeviceFlowLike } from "./github-sign-in";
import type { StoredCredential } from "./credential-vault";

const authorization: GitHubDeviceAuthorization = {
  deviceCode: "device-code",
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  expiresAt: "2026-11-04T12:15:00.000Z",
  interval: 5
};

const token: OAuthTokenSet = {
  accessToken: "gho_token",
  refreshToken: null,
  expiresAt: null,
  tokenType: "bearer",
  scope: "read:user,repo"
};

function setUp(overrides: Partial<GitHubDeviceFlowLike> = {}, uri = authorization.verificationUri) {
  const saved: StoredCredential[] = [];
  const opened: string[] = [];
  const flow: GitHubDeviceFlowLike = {
    start: async () => ({ ...authorization, verificationUri: uri }),
    waitForToken: async () => token,
    ...overrides
  };
  const signIn = new GitHubSignIn(
    "github",
    () => flow,
    { save: async (credential) => { saved.push(credential); } },
    async (url) => { opened.push(url); }
  );
  return { signIn, saved, opened };
}

describe("GitHubSignIn", () => {
  it("shows the code, then saves the token once the user approves", async () => {
    const { signIn, saved, opened } = setUp();

    await expect(signIn.start()).resolves.toEqual({
      kind: "code",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresAt: authorization.expiresAt
    });
    await signIn.openPage();
    await signIn.finish();

    expect(opened).toEqual(["https://github.com/login/device"]);
    expect(saved).toEqual([{ provider: "github", ...token }]);
    await expect(signIn.finish()).rejects.toThrow("has not started");
  });

  it("opens only GitHub's own address", async () => {
    const { signIn, opened } = setUp({}, "https://evil.example/login/device");
    await signIn.start();

    await expect(signIn.openPage()).rejects.toThrow("unexpected sign-in address");
    expect(opened).toEqual([]);
  });

  it("stops waiting when cancelled", async () => {
    const waitForToken = vi.fn((_authorization: GitHubDeviceAuthorization, signal?: AbortSignal) =>
      new Promise<OAuthTokenSet>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("GitHub sign-in was cancelled.")));
      }));
    const { signIn, saved } = setUp({ waitForToken });
    await signIn.start();
    const waiting = signIn.finish();
    signIn.cancel();

    await expect(waiting).rejects.toThrow("cancelled");
    expect(saved).toEqual([]);
  });

  it("cancels an earlier sign-in when a new one starts", async () => {
    const signals: AbortSignal[] = [];
    const { signIn } = setUp({
      waitForToken: (_authorization, signal) => {
        if (signal !== undefined) signals.push(signal);
        return new Promise<OAuthTokenSet>(() => undefined);
      }
    });
    await signIn.start();
    void signIn.finish();
    await signIn.start();

    expect(signals[0]?.aborted).toBe(true);
  });
});
