import { describe, expect, it, vi } from "vitest";
import type { OAuthTokenSet } from "@mcp-connector/core";
import type { StoredCredential } from "./credential-vault";
import { VaultTokenProvider } from "./vault-token-provider";

function vaultWith(credential: StoredCredential | null) {
  let stored = credential;
  return {
    get: async () => stored,
    save: async (next: StoredCredential) => { stored = next; },
    current: () => stored
  };
}

const expired: StoredCredential = {
  provider: "notion",
  accessToken: "old",
  refreshToken: "refresh-1",
  expiresAt: "2000-01-01T00:00:00.000Z",
  tokenType: "bearer",
  scope: null
};

describe("VaultTokenProvider", () => {
  it("returns a token that has no expiry", async () => {
    const vault = vaultWith({ ...expired, provider: "github", expiresAt: null, refreshToken: null });
    await expect(new VaultTokenProvider(vault, "github", null).getAccessToken()).resolves.toBe("old");
  });

  it("says how to fix a missing connection", async () => {
    await expect(new VaultTokenProvider(vaultWith(null), "github", null).getAccessToken())
      .rejects.toThrow("GitHub is not connected");
  });

  it("asks to connect again when an expired token cannot be refreshed", async () => {
    await expect(new VaultTokenProvider(vaultWith({ ...expired, provider: "github" }), "github", null).getAccessToken())
      .rejects.toThrow("Connect GitHub again");
  });

  it("refreshes an expired token once and saves it", async () => {
    const vault = vaultWith(expired);
    const refreshed: OAuthTokenSet = { accessToken: "new", refreshToken: "refresh-2", expiresAt: null, tokenType: "bearer", scope: null };
    const refresh = vi.fn(async () => refreshed);
    const provider = new VaultTokenProvider(vault, "notion", refresh);

    await expect(Promise.all([provider.getAccessToken(), provider.getAccessToken()])).resolves.toEqual(["new", "new"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("refresh-1");
    expect(vault.current()).toMatchObject({ accessToken: "new", refreshToken: "refresh-2" });
  });
});
