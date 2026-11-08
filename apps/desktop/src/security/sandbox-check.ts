// MCP Connector never runs with Chromium's sandbox turned off. The launcher
// electron-builder puts in the AppImage adds --no-sandbox by itself whenever
// `unshare -Ur true` fails, which is what happens on Ubuntu 23.10 and newer:
// AppArmor there blocks the user namespaces the sandbox needs, for programs
// without a profile that allows them. Rather than start unprotected without a
// word, the app says what to do and quits. The .deb installs such a profile.

export const NO_SANDBOX_SWITCH = "no-sandbox";

export interface SandboxRefusal {
  readonly title: string;
  readonly message: string;
}

/** What to tell the user when the app was started with --no-sandbox, or null when it was not. */
export function sandboxRefusal(input: {
  readonly noSandbox: boolean;
  /** Set by the AppImage runtime to the AppImage file's path. */
  readonly appImagePath: string | undefined;
}): SandboxRefusal | null {
  if (!input.noSandbox) return null;
  const fix = input.appImagePath !== undefined && input.appImagePath.length > 0
    ? "This happens with the AppImage on Ubuntu 23.10 and newer, which block the sandbox for programs they don't "
      + "know. Install MCP Connector's .deb package instead, or allow the AppImage with the AppArmor profile "
      + "described in the release notes, then start it again."
    : "Start MCP Connector again without --no-sandbox.";
  return {
    title: "MCP Connector can't start safely",
    message: "MCP Connector was started with its sandbox turned off (--no-sandbox), so it closed instead of "
      + `running without it.\n\n${fix}`
  };
}
