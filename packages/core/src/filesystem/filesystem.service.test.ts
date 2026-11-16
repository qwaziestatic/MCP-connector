import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_READ_LINES,
  FilesystemService,
  isPathWithinRoot,
  MAX_READ_FILE_BYTES,
  namesFileStream,
  WEB_READ_CHARACTERS,
  secretFileReason
} from "./filesystem.service.js";

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

  it("lists links without following them out of the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mcp-connector-"));
    const outside = await mkdtemp(join(tmpdir(), "mcp-connector-outside-"));
    temporaryDirectories.push(workspace, outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await writeFile(join(workspace, "index.ts"), "export {};");
    await symlink(outside, join(workspace, "linked"), "junction");

    const snapshot = await new FilesystemService().inspectWorkspace(workspace);

    expect(snapshot.entries.map((entry) => [entry.relativePath, entry.type]).sort()).toEqual([
      ["index.ts", "file"],
      ["linked", "symlink"]
    ]);
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

describe("reading a file", () => {
  async function setUp(files: Readonly<Record<string, string | Buffer>> = {}) {
    const workspace = await mkdtemp(join(tmpdir(), "mcp-read-"));
    temporaryDirectories.push(workspace);
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(workspace, name, ".."), { recursive: true });
      await writeFile(join(workspace, name), content);
    }
    const filesystem = new FilesystemService();
    filesystem.setAllowedWorkspaceRoot(workspace);
    return { workspace, filesystem };
  }

  it("returns a file's text, its line count, and that nothing remains", async () => {
    const { filesystem } = await setUp({ "src/index.ts": "export const a = 1;\nexport const b = 2;\n" });

    expect(await filesystem.readTextFile("src/index.ts")).toEqual({
      path: "src/index.ts",
      totalLines: 2,
      startLine: 1,
      endLine: 2,
      hasMore: false,
      text: "export const a = 1;\nexport const b = 2;"
    });
    // However the path is spelled, the answer names the file inside the workspace.
    expect((await filesystem.readTextFile("./src/../src/index.ts")).path).toBe("src/index.ts");
  });

  it("reads a large file in parts, saying how many lines there are and whether more remain", async () => {
    const lines = Array.from({ length: 4_500 }, (_unused, index) => `line ${index + 1}`);
    const { filesystem } = await setUp({ "log.txt": lines.join("\r\n") });

    const first = await filesystem.readTextFile("log.txt");
    expect(first).toMatchObject({ totalLines: 4_500, startLine: 1, endLine: DEFAULT_READ_LINES, hasMore: true });
    expect(first.text.split("\n")).toHaveLength(DEFAULT_READ_LINES);

    const middle = await filesystem.readTextFile("log.txt", { startLine: first.endLine + 1, maxLines: 3 });
    expect(middle).toEqual({ path: "log.txt", totalLines: 4_500, startLine: 2_001, endLine: 2_003, hasMore: true, text: "line 2001\nline 2002\nline 2003" });

    const last = await filesystem.readTextFile("log.txt", { startLine: 4_499, maxLines: 100 });
    expect(last).toMatchObject({ startLine: 4_499, endLine: 4_500, hasMore: false, text: "line 4499\nline 4500" });

    await expect(filesystem.readTextFile("log.txt", { startLine: 4_501 })).rejects.toThrow("has 4500 lines, so there is no line 4501");
  });

  it("stops at a character budget on a whole line, and says truly where it stopped", async () => {
    const lines = Array.from({ length: 900 }, (_unused, index) => `line ${index + 1} ${"x".repeat(index % 90)}`);
    const { filesystem } = await setUp({ "long.txt": `${lines.join("\n")}\n` });

    const first = await filesystem.readTextFile("long.txt", { maxCharacters: WEB_READ_CHARACTERS });
    expect(first.text.length).toBeLessThanOrEqual(WEB_READ_CHARACTERS);
    expect(first).toMatchObject({ totalLines: 900, startLine: 1, hasMore: true });
    expect(first.endLine).toBeLessThan(900);
    // Exactly the lines it says, whole, and the next line would not have fitted.
    expect(first.text).toBe(lines.slice(0, first.endLine).join("\n"));
    expect(first.text.length + 1 + lines[first.endLine]!.length).toBeGreaterThan(WEB_READ_CHARACTERS);
    expect(first.note).toBeUndefined();

    // Reading on from endLine + 1 gives the whole file, with nothing lost or repeated.
    const parts = [first];
    while (parts.at(-1)!.hasMore) {
      parts.push(await filesystem.readTextFile("long.txt", { startLine: parts.at(-1)!.endLine + 1, maxCharacters: WEB_READ_CHARACTERS }));
    }
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.map((part) => part.text).join("\n")).toBe(lines.join("\n"));
    expect(parts.at(-1)).toMatchObject({ endLine: 900, hasMore: false });
  });

  it("applies the smaller of the line limit and the character budget, and neither to a short file", async () => {
    const lines = Array.from({ length: 50 }, (_unused, index) => `line ${index + 1}`);
    const { filesystem } = await setUp({ "short.txt": lines.join("\n") });

    expect(await filesystem.readTextFile("short.txt", { maxCharacters: WEB_READ_CHARACTERS }))
      .toEqual(await filesystem.readTextFile("short.txt"));
    expect(await filesystem.readTextFile("short.txt", { startLine: 10, maxLines: 3, maxCharacters: WEB_READ_CHARACTERS }))
      .toMatchObject({ startLine: 10, endLine: 12, hasMore: true, text: "line 10\nline 11\nline 12" });
    expect(await filesystem.readTextFile("short.txt", { maxLines: 40, maxCharacters: 20 }))
      .toMatchObject({ startLine: 1, endLine: 3, hasMore: true, text: "line 1\nline 2\nline 3" });
  });

  it("returns the start of a line too long for the budget, and says the rest is missing", async () => {
    const { filesystem } = await setUp({ "bundle.min.js": `${"a".repeat(40_000)}\nsecond line\n`, "emoji.txt": `${"ab😀".repeat(10)}` });

    const read = await filesystem.readTextFile("bundle.min.js", { maxCharacters: WEB_READ_CHARACTERS });
    expect(read).toMatchObject({ totalLines: 2, startLine: 1, endLine: 1, hasMore: true });
    expect(read.text).toBe("a".repeat(WEB_READ_CHARACTERS));
    expect(read.note).toBe("Line 1 is 40,000 characters long. Only its first 16,000 are returned, and the rest of that line cannot be read with this tool.");
    // The next call moves on to the next line instead of repeating this one.
    expect(await filesystem.readTextFile("bundle.min.js", { startLine: 2, maxCharacters: WEB_READ_CHARACTERS }))
      .toMatchObject({ startLine: 2, endLine: 2, hasMore: false, text: "second line" });
    // Never half a character.
    expect((await filesystem.readTextFile("emoji.txt", { maxCharacters: 3 })).text).toBe("ab");
    expect((await filesystem.readTextFile("emoji.txt", { maxCharacters: 4 })).text).toBe("ab😀");
  });

  it("reads an empty file as no lines", async () => {
    const { filesystem } = await setUp({ "empty.txt": "" });
    expect(await filesystem.readTextFile("empty.txt")).toEqual({ path: "empty.txt", totalLines: 0, startLine: 0, endLine: 0, hasMore: false, text: "" });
  });

  it("refuses paths outside the workspace, including through ..", async () => {
    const { workspace, filesystem } = await setUp({ "notes.md": "inside" });
    const outside = await mkdtemp(join(tmpdir(), "mcp-read-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.txt"), "outside");

    for (const path of ["../secret.txt", "src/../../secret.txt", join(outside, "secret.txt"), "..", ".", workspace]) {
      await expect(filesystem.readTextFile(path), path).rejects.toThrow("outside the user-selected workspace");
    }
  });

  it("refuses a file reached through a link that leaves the workspace", async () => {
    const { workspace, filesystem } = await setUp({ "notes.md": "inside" });
    const outside = await mkdtemp(join(tmpdir(), "mcp-read-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(workspace, "linked"), "junction");

    await expect(filesystem.readTextFile("linked/secret.txt")).rejects.toThrow("outside the user-selected workspace");
  });

  it("refuses a harmless-looking link to a secret folder inside the workspace", async () => {
    const { workspace, filesystem } = await setUp({ ".git/config": "[remote]\n  url = https://user:token@example.com/repo.git" });
    await symlink(join(workspace, ".git"), join(workspace, "history"), "junction");

    await expect(filesystem.readTextFile("history/config")).rejects.toThrow("inside a .git folder");
  });

  it("refuses files over the size limit", async () => {
    const { filesystem } = await setUp({
      "big.txt": "x".repeat(MAX_READ_FILE_BYTES + 1),
      "just-fits.txt": "x".repeat(MAX_READ_FILE_BYTES)
    });

    await expect(filesystem.readTextFile("big.txt")).rejects.toThrow("big.txt is too large to read: 1,000,001 bytes, and the limit is 1,000,000.");
    // A range does not get around the limit.
    await expect(filesystem.readTextFile("big.txt", { startLine: 1, maxLines: 1 })).rejects.toThrow("too large to read");
    expect((await filesystem.readTextFile("just-fits.txt")).totalLines).toBe(1);
  });

  it("refuses binary files", async () => {
    const { filesystem } = await setUp({
      "image.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
      "latin1.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      "utf16.txt": Buffer.from("hello", "utf16le"),
      "accents.txt": "café ☕"
    });

    for (const name of ["image.png", "latin1.txt", "utf16.txt"]) {
      await expect(filesystem.readTextFile(name), name).rejects.toThrow(`${name} is not a text file`);
    }
    expect((await filesystem.readTextFile("accents.txt")).text).toBe("café ☕");
  });

  it("refuses a folder, a missing file, and any read before a workspace is selected", async () => {
    const { filesystem } = await setUp({ "src/index.ts": "x" });
    await expect(filesystem.readTextFile("src")).rejects.toThrow("src is not a file");
    await expect(filesystem.readTextFile("missing.txt")).rejects.toThrow("There is no file at missing.txt");
    await expect(new FilesystemService().readTextFile("notes.md")).rejects.toThrow("Select a workspace");
  });

  describe("files that usually hold secrets", () => {
    const refused: ReadonlyArray<readonly [string, string]> = [
      [".env", "environment file"],
      [".env.local", "environment file"],
      [".env.production", "environment file"],
      ["config/.ENV", "environment file"],
      ["certs/server.pem", "Files ending in .pem"],
      ["certs/server.key", "Files ending in .key"],
      ["certs/identity.p12", "Files ending in .p12"],
      ["certs/identity.pfx", "Files ending in .pfx"],
      ["keys/putty.ppk", "Files ending in .ppk"],
      ["android/release.jks", "Files ending in .jks"],
      ["android/debug.keystore", "Files ending in .keystore"],
      ["id_rsa", "SSH private key"],
      ["keys/id_ed25519", "SSH private key"],
      ["keys/id_ecdsa", "SSH private key"],
      ["keys/id_dsa", "SSH private key"],
      [".npmrc", ".npmrc files usually hold npm sign-in tokens"],
      ["packages/web/.npmrc", ".npmrc files usually hold npm sign-in tokens"],
      [".netrc", ".netrc files usually hold passwords for servers"],
      [".pypirc", ".pypirc files usually hold passwords for Python package indexes"],
      ["infra/terraform.tfstate", "Terraform state and variable files"],
      ["infra/terraform.tfstate.backup", "Terraform state and variable files"],
      ["infra/prod.tfstate.1700000000.backup", "Terraform state and variable files"],
      ["infra/production.tfvars", "Terraform state and variable files"],
      [".git/config", "inside a .git folder"],
      [".git/HEAD", "inside a .git folder"],
      ["vendor/lib/.git/config", "inside a .git folder"],
      [".ssh/config", "inside a .ssh folder"],
      [".ssh/known_hosts", "inside a .ssh folder"],
      [".ssh/id_ed25519.pub", "inside a .ssh folder"],
      [".aws/credentials", "inside a .aws folder"],
      ["home/.aws/config", "inside a .aws folder"]
    ];

    for (const [path, reason] of refused) {
      it(`refuses ${path} and says why`, async () => {
        const { filesystem } = await setUp({ [path]: "SECRET=1" });
        await expect(filesystem.readTextFile(path)).rejects.toThrow(reason);
        await expect(filesystem.readTextFile(path)).rejects.toThrow("MCP Connector does not read");
        // The preview for a web chat refuses it too, before anything is queued.
        expect(() => filesystem.describeRead(path)).toThrow(reason);
      });
    }

    it("still reads the files next to them that hold no secrets", async () => {
      const allowed = [
        ".env.example", ".env.sample", ".env.template", "id_rsa.pub", ".gitignore", ".github/workflows/ci.yml",
        "docs/keys.md", "src/env.ts", "infra/main.tf", "docs/aws/setup.md", "src/ssh/client.ts", "npmrc.md"
      ];
      const { filesystem } = await setUp(Object.fromEntries(allowed.map((path) => [path, "public"])));
      for (const path of allowed) {
        expect((await filesystem.readTextFile(path)).text, path).toBe("public");
        expect(secretFileReason(path), path).toBeNull();
      }
    });
  });

  describe("Windows file streams", () => {
    const streams = [".env::$DATA", "server.key::$DATA", "server.key:stream", "notes.txt:hidden", "notes.txt::$DATA", ".git::$INDEX_ALLOCATION/config"];

    it("treats a colon in a path as a stream on Windows only", () => {
      for (const path of streams) {
        expect(namesFileStream(path, "win32"), path).toBe(true);
        // On Linux and macOS a colon is an ordinary character in a name.
        expect(namesFileStream(path, "linux"), path).toBe(false);
        expect(namesFileStream(path, "darwin"), path).toBe(false);
      }
      expect(namesFileStream("src/index.ts", "win32")).toBe(false);
    });

    it("does not let a secret file's name hide behind dots or spaces that Windows ignores", () => {
      for (const path of [".env.", ".env. .", "server.key.", ".git./config", ".ENV"]) {
        expect(secretFileReason(path), path).not.toBeNull();
      }
    });

    it.runIf(process.platform === "win32")("refuses every path that names a stream, for reading and for the preview", async () => {
      const { workspace, filesystem } = await setUp({ ".env": "API_KEY=1", "server.key": "KEY", "notes.txt": "plain", ".git/config": "token" });
      // A named stream holds data that no listing of the folder shows.
      await writeFile(join(workspace, "notes.txt:hidden"), "hidden text");

      for (const path of streams) {
        await expect(filesystem.readTextFile(path), path).rejects.toThrow("a colon in a path names a hidden stream");
        expect(() => filesystem.describeRead(path), path).toThrow("a colon in a path names a hidden stream");
      }
      // The drive letter's own colon is not a stream.
      expect((await filesystem.readTextFile(join(workspace, "notes.txt"))).text).toBe("plain");
    });

    it.runIf(process.platform !== "win32")("reads a file whose name has a colon where that is an ordinary name", async () => {
      const { filesystem } = await setUp({ "notes:draft.txt": "plain", ".env:backup": "API_KEY=1" });
      expect((await filesystem.readTextFile("notes:draft.txt")).text).toBe("plain");
      // Not a stream here, so it is a different file from .env, with its own name.
      expect((await filesystem.readTextFile(".env:backup")).text).toBe("API_KEY=1");
    });
  });

  it("describes a read by the file's path in the workspace and the lines asked for", async () => {
    const { workspace, filesystem } = await setUp({ "src/index.ts": "x" });
    expect(filesystem.describeRead("./src/../src/index.ts")).toEqual({ file: "src/index.ts" });
    expect(filesystem.describeRead(join(workspace, "src", "index.ts"), { startLine: 10, maxLines: 50 })).toEqual({ file: "src/index.ts", lines: "10 to 59" });
    expect(filesystem.describeRead("src/index.ts", { maxLines: 20 })).toEqual({ file: "src/index.ts", lines: "1 to 20" });
    expect(filesystem.describeRead("src/index.ts", { startLine: 300 })).toEqual({ file: "src/index.ts", lines: "300 onwards" });
    expect(() => filesystem.describeRead("../elsewhere.txt")).toThrow("outside the user-selected workspace");
  });
});
