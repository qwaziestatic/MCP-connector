import { describe, expect, it } from "vitest";
import { sandboxRefusal } from "./sandbox-check";

describe("sandboxRefusal", () => {
  it("lets the app start when the sandbox is on", () => {
    expect(sandboxRefusal({ noSandbox: false, appImagePath: "/home/leul/MCP.AppImage" })).toBeNull();
    expect(sandboxRefusal({ noSandbox: false, appImagePath: undefined })).toBeNull();
  });

  it("refuses an AppImage started without the sandbox, and points to the .deb and the AppArmor profile", () => {
    const refusal = sandboxRefusal({ noSandbox: true, appImagePath: "/home/leul/MCP.AppImage" });

    expect(refusal?.title).toBe("MCP Connector can't start safely");
    expect(refusal?.message).toContain("--no-sandbox");
    expect(refusal?.message).toContain(".deb");
    expect(refusal?.message).toContain("AppArmor profile");
  });

  it("asks anyone else to start it without --no-sandbox", () => {
    expect(sandboxRefusal({ noSandbox: true, appImagePath: undefined })?.message)
      .toContain("Start MCP Connector again without --no-sandbox.");
    expect(sandboxRefusal({ noSandbox: true, appImagePath: "" })?.message)
      .toContain("Start MCP Connector again without --no-sandbox.");
  });
});
