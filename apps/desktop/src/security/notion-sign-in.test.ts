import { describe, expect, it } from "vitest";
import type { NotionSignInResult } from "@mcp-connector/core";
import type { StoredCredential } from "./credential-vault";
import { OAuthCallbackServer } from "./oauth-callback-server";
import { NotionSignIn, type NotionSignInClientLike } from "./notion-sign-in";

const result: NotionSignInResult = {
  token: { accessToken: "ntn_token", refreshToken: "nrt_1", expiresAt: null, tokenType: "bearer", scope: null },
  workspaceName: "Team space"
};

/**
 * The real return listener, with a fake sign-in service: "opening the browser"
 * goes straight back to the app with whatever the browser would bring.
 */
function setUp(browser: (port: number, state: string) => string | null, client: Partial<NotionSignInClientLike> = {}) {
  const saved: StoredCredential[] = [];
  const opened: string[] = [];
  const servers: OAuthCallbackServer[] = [];
  const exchanged: string[] = [];
  const signIn = new NotionSignIn(
    "notion",
    () => ({
      authorizationUrl: (port, state) => browser(port, state) ?? `http://127.0.0.1:${port}/never`,
      exchangeCode: async (code) => {
        exchanged.push(code);
        return result;
      },
      ...client
    }),
    () => {
      const server = new OAuthCallbackServer();
      servers.push(server);
      return server;
    },
    { save: async (credential) => { saved.push(credential); } },
    async (url) => {
      opened.push(url);
      // The browser comes back at once, before the app starts waiting.
      if (!url.endsWith("/never")) await fetch(url);
    },
    () => "state-from-the-app"
  );
  return { signIn, saved, opened, servers, exchanged };
}

describe("NotionSignIn", () => {
  it("saves the token once the browser comes back with a code", async () => {
    const { signIn, saved, exchanged } = setUp((port, state) => `http://127.0.0.1:${port}/oauth/callback?code=abc&state=${state}`);

    await expect(signIn.start()).resolves.toEqual({ kind: "browser" });
    await signIn.finish();

    expect(exchanged).toEqual(["abc"]);
    expect(saved).toEqual([{ provider: "notion", ...result.token }]);
  });

  it("refuses a return it did not start", async () => {
    const { signIn, saved, exchanged } = setUp((port) => `http://127.0.0.1:${port}/oauth/callback?code=abc&state=someone-else`);

    await signIn.start();
    await expect(signIn.finish()).rejects.toThrow("did not start in MCP Connector");
    expect(exchanged).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("explains a sign-in declined in the browser", async () => {
    const { signIn } = setUp((port, state) => `http://127.0.0.1:${port}/oauth/callback?error=access_denied&state=${state}`);
    await signIn.start();
    await expect(signIn.finish()).rejects.toThrow("declined in the browser");
  });

  it("stops waiting and closes its listener when cancelled", async () => {
    const { signIn, saved, opened } = setUp(() => null);
    await signIn.start();
    const connecting = signIn.finish();
    const port = new URL(opened[0] ?? "").port;
    signIn.cancel();

    await expect(connecting).rejects.toThrow("cancelled");
    expect(saved).toEqual([]);
    await expect(fetch(`http://127.0.0.1:${port}/oauth/callback`)).rejects.toThrow();
  });

  it("opens nothing when this copy has no sign-in service", async () => {
    const opened: string[] = [];
    const signIn = new NotionSignIn(
      "notion",
      () => { throw new Error("Notion sign-in is not set up in this copy of MCP Connector"); },
      () => new OAuthCallbackServer(),
      { save: async () => undefined },
      async (url) => { opened.push(url); }
    );

    await expect(signIn.start()).rejects.toThrow("not set up");
    expect(opened).toEqual([]);
  });
});
