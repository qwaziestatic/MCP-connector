import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemService } from "./filesystem.service.js";

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
    expect(() => service.resolveWorkspaceFile(workspace, "..\\outside.txt")).toThrow(
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
});
