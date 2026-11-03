import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemService, isPathWithinRoot } from "./filesystem.service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true
  })));
});

describe("FilesystemService", () => {
  it("inspects files and README content while ignoring generated directories", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mcp-connector-"));
    temporaryDirectories.push(workspace);
    await writeFile(join(workspace, "README.md"), "# Project");
    await writeFile(join(workspace, "index.ts"), "export {};");
    await mkdir(join(workspace, "node_modules"));
    await writeFile(join(workspace, "node_modules", "ignored.js"), "ignored");

    const snapshot = await new FilesystemService().inspectWorkspace(workspace);

    expect(snapshot.readme).toBe("# Project");
    expect(snapshot.entries.map((entry) => entry.relativePath).sort()).toEqual(["README.md", "index.ts"]);
  });

  it("rejects workspace file paths and traversal targets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mcp-connector-"));
    temporaryDirectories.push(workspace);
    const filePath = join(workspace, "file.txt");
    await writeFile(filePath, "content");
    const service = new FilesystemService();

    await expect(service.inspectWorkspace(filePath)).rejects.toThrow("must refer to a directory");
    expect(() => service.resolveWorkspaceFile(workspace, join("..", "outside.txt"))).toThrow(
      "outside the selected workspace"
    );
  });

  it("rejects symlinked directory entries that escape the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mcp-connector-"));
    const outside = await mkdtemp(join(tmpdir(), "mcp-connector-outside-"));
    temporaryDirectories.push(workspace, outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(workspace, "linked"), "junction");

    await expect(new FilesystemService().inspectWorkspace(workspace)).rejects.toThrow(
      "Symbolic links are not allowed"
    );
  });

  it("restricts inspection to the selected workspace root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mcp-connector-"));
    const outside = await mkdtemp(join(tmpdir(), "mcp-connector-outside-"));
    temporaryDirectories.push(workspace, outside);
    const service = new FilesystemService();
    service.setAllowedWorkspaceRoot(workspace);

    await expect(service.inspectWorkspace(outside)).rejects.toThrow(
      "outside the user-selected workspace"
    );
  });

  it.runIf(process.platform === "win32")("rejects paths on a different drive", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mcp-connector-"));
    temporaryDirectories.push(workspace);
    const otherDrive = workspace.toUpperCase().startsWith("Z:") ? "Y:\\" : "Z:\\";
    const service = new FilesystemService();
    service.setAllowedWorkspaceRoot(workspace);

    await expect(service.inspectWorkspace(otherDrive)).rejects.toThrow(
      "outside the user-selected workspace"
    );
    expect(() => service.resolveWorkspaceFile(workspace, `${otherDrive}outside.txt`)).toThrow(
      "outside the selected workspace"
    );
  });

  it("rejects workspace paths that traverse a junction out of the selected root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mcp-connector-"));
    const outside = await mkdtemp(join(tmpdir(), "mcp-connector-outside-"));
    temporaryDirectories.push(workspace, outside);
    await mkdir(join(outside, "nested"));
    await writeFile(join(outside, "nested", "secret.txt"), "secret");
    await symlink(outside, join(workspace, "linked"), "junction");
    const service = new FilesystemService();
    service.setAllowedWorkspaceRoot(workspace);

    await expect(service.inspectWorkspace(join(workspace, "linked", "nested"))).rejects.toThrow(
      "outside the user-selected workspace"
    );
  });
});

// The containment rules are checked with both path implementations, so the
// Windows rules are tested on Linux and macOS too, and the POSIX rules on Windows.
describe("isPathWithinRoot", () => {
  const windowsRoot = "C:\\Users\\leul\\project";
  it.each([
    ["the root itself", windowsRoot, true],
    ["a subfolder", "C:\\Users\\leul\\project\\src", true],
    ["a subfolder in different letter case", "c:\\USERS\\LEUL\\PROJECT\\src", true],
    ["the parent folder", "C:\\Users\\leul", false],
    ["a parent traversal", "C:\\Users\\leul\\project\\..\\secret", false],
    ["a sibling sharing the name prefix", "C:\\Users\\leul\\project2", false],
    ["another drive", "D:\\private", false],
    ["a UNC network share", "\\\\server\\share\\x", false]
  ])("Windows: %s", (_name, candidate, expected) => {
    expect(isPathWithinRoot(windowsRoot, path.win32.resolve(candidate), path.win32)).toBe(expected);
  });

  const posixRoot = "/home/leul/project";
  it.each([
    ["the root itself", posixRoot, true],
    ["a subfolder", "/home/leul/project/src", true],
    ["a file named with a backslash", "/home/leul/project/..\\outside.txt", true],
    ["the parent folder", "/home/leul", false],
    ["a parent traversal", "/home/leul/project/../secret", false],
    ["a sibling sharing the name prefix", "/home/leul/project2", false],
    ["an unrelated absolute path", "/etc/passwd", false]
  ])("POSIX: %s", (_name, candidate, expected) => {
    expect(isPathWithinRoot(posixRoot, path.posix.resolve(candidate), path.posix)).toBe(expected);
  });
});
