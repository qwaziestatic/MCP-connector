import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path, { dirname, relative, resolve } from "node:path";

export interface WorkspaceEntry {
  readonly relativePath: string;
  readonly type: "file" | "directory" | "symlink";
  readonly sizeBytes: number;
}

export interface WorkspaceSnapshot {
  readonly workspacePath: string;
  readonly entries: readonly WorkspaceEntry[];
  readonly readme: string | null;
}

/** One file's text, or the part of it that was asked for. */
export interface FileText {
  /** The file's path inside the workspace, with forward slashes. */
  readonly path: string;
  /** How many lines the whole file has. */
  readonly totalLines: number;
  /** The first and last line returned, counted from 1. Both are 0 for an empty file. */
  readonly startLine: number;
  readonly endLine: number;
  /** Whether lines remain after endLine. */
  readonly hasMore: boolean;
  readonly text: string;
}

export interface ReadRange {
  /** The first line to return, counted from 1. */
  readonly startLine?: number | undefined;
  /** How many lines to return at most. */
  readonly maxLines?: number | undefined;
}

/** Larger files are refused, not cut: read_file is for text a person would open. */
export const MAX_READ_FILE_BYTES = 1_000_000;
/** How many lines one call returns unless it asks for fewer. */
export const DEFAULT_READ_LINES = 2_000;

const SSH_PRIVATE_KEY = /^id_(rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk)$/u;
/** Folders whose contents are never read, and what they hold. */
const SECRET_FOLDERS: Readonly<Record<string, string>> = {
  ".git": "which can hold sign-in details for the repository's remotes",
  ".ssh": "which holds SSH keys and the servers they open",
  ".aws": "which holds AWS access keys"
};
/** Files that are never read, by name, and what they hold. */
const SECRET_NAMES: Readonly<Record<string, string>> = {
  ".npmrc": "npm sign-in tokens",
  ".netrc": "passwords for servers",
  ".pypirc": "passwords for Python package indexes"
};
/** The .env files that hold examples, not secrets. */
const EXAMPLE_ENV_FILES: ReadonlySet<string> = new Set([".env.example", ".env.sample", ".env.template"]);

/**
 * Why a file is not read even though it is inside the workspace, or null. It
 * covers the files that usually hold secrets: an agent or a web chat has no
 * need for them, and what a tool reads can end up in a chat. The list is a
 * safety net for common cases, not a complete list of secret files.
 */
export function secretFileReason(relativePath: string): string | null {
  const parts = relativePath.split(/[\\/]+/u)
    // Compared without case, and without the dots and spaces Windows ignores
    // at the end of a name: ".ENV" and ".env." both open ".env" there.
    .map((part) => part.toLowerCase().replace(/[. ]+$/u, ""))
    .filter((part) => part.length > 0);
  const name = parts.at(-1) ?? "";
  const folder = parts.find((part) => part in SECRET_FOLDERS);
  if (folder !== undefined) {
    return `It is inside a ${folder} folder, ${SECRET_FOLDERS[folder]}.`;
  }
  if (name === ".env" || (name.startsWith(".env.") && !EXAMPLE_ENV_FILES.has(name))) {
    return "It is an environment file (.env), which usually holds passwords and API keys. "
      + "Only .env.example, .env.sample and .env.template can be read.";
  }
  if (name in SECRET_NAMES) {
    return `${name} files usually hold ${SECRET_NAMES[name]}.`;
  }
  if (/\.(pem|key|p12|pfx|ppk|jks|keystore)$/u.test(name)) {
    return `Files ending in ${name.slice(name.lastIndexOf("."))} usually hold private keys or certificates.`;
  }
  if (/\.tfstate($|\.)/u.test(name) || name.endsWith(".tfvars")) {
    return "Terraform state and variable files usually hold passwords and keys for the things they describe.";
  }
  if (SSH_PRIVATE_KEY.test(name)) {
    return "It looks like an SSH private key.";
  }
  return null;
}

/**
 * Whether a path inside the workspace names a stream of a file, as a colon
 * does on Windows ("notes.txt:hidden", ".env::$DATA"). A stream is another
 * way to the same file, or to data hidden beside it, so the name checks
 * cannot be trusted for such a path. Elsewhere a colon is an ordinary
 * character in a file's name.
 */
export function namesFileStream(relativePath: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && relativePath.includes(":");
}

const MAX_ENTRIES = 2_000;
const MAX_README_BYTES = 256_000;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build"
]);

function assertWorkspacePath(workspacePath: string): string {
  const normalizedPath = resolve(workspacePath);
  if (normalizedPath.length === 0) {
    throw new Error("Workspace path must not be empty.");
  }
  return normalizedPath;
}

/**
 * Reports whether `candidatePath` is `rootPath` or inside it. `pathApi` defaults
 * to the current platform's rules; tests pass `path.win32` or `path.posix` so
 * both rule sets are checked on every operating system.
 */
export function isPathWithinRoot(
  rootPath: string,
  candidatePath: string,
  pathApi: typeof path.posix = path
): boolean {
  const relativePath = pathApi.relative(rootPath, candidatePath);
  // On Windows, paths on different drives or UNC shares produce an absolute relative path.
  return relativePath === "" || (
    !pathApi.isAbsolute(relativePath)
    && !relativePath.startsWith(`..${pathApi.sep}`)
    && relativePath !== ".."
  );
}

function isWithinWorkspace(workspacePath: string, candidatePath: string): boolean {
  return isPathWithinRoot(workspacePath, candidatePath);
}

async function walkDirectory(
  workspacePath: string,
  directoryPath: string,
  entries: WorkspaceEntry[]
): Promise<void> {
  if (entries.length >= MAX_ENTRIES) {
    return;
  }

  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of directoryEntries) {
    if (entries.length >= MAX_ENTRIES) {
      break;
    }
    if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }

    const entryPath = resolve(directoryPath, entry.name);
    if (!isWithinWorkspace(workspacePath, entryPath)) {
      throw new Error(`Resolved path escapes workspace: ${entry.name}`);
    }
    if (entry.isSymbolicLink()) {
      // Listed but never followed, so a link cannot lead outside the workspace.
      entries.push({
        relativePath: relative(workspacePath, entryPath),
        type: "symlink",
        sizeBytes: 0
      });
      continue;
    }

    if (entry.isDirectory()) {
      entries.push({
        relativePath: relative(workspacePath, entryPath),
        type: "directory",
        sizeBytes: 0
      });
      await walkDirectory(workspacePath, entryPath, entries);
      continue;
    }

    if (entry.isFile()) {
      const metadata = await lstat(entryPath);
      entries.push({
        relativePath: relative(workspacePath, entryPath),
        type: "file",
        sizeBytes: metadata.size
      });
    }
  }
}

export class FilesystemService {
  private allowedWorkspaceRoot: string | undefined;

  public setAllowedWorkspaceRoot(workspacePath: string): void {
    this.allowedWorkspaceRoot = assertWorkspacePath(workspacePath);
  }

  public getAllowedWorkspaceRoot(): string | undefined {
    return this.allowedWorkspaceRoot;
  }

  async inspectWorkspace(workspacePath: string): Promise<WorkspaceSnapshot> {
    const normalizedWorkspacePath = assertWorkspacePath(workspacePath);
    if (
      this.allowedWorkspaceRoot !== undefined
      && !isWithinWorkspace(this.allowedWorkspaceRoot, normalizedWorkspacePath)
    ) {
      throw new Error("Workspace path is outside the user-selected workspace.");
    }
    const metadata = await lstat(normalizedWorkspacePath);

    if (!metadata.isDirectory()) {
      throw new Error("Workspace path must refer to a directory.");
    }
    if (
      this.allowedWorkspaceRoot !== undefined
      && !isWithinWorkspace(
        await realpath(this.allowedWorkspaceRoot),
        await realpath(normalizedWorkspacePath)
      )
    ) {
      // A symlink or junction in an intermediate path component can escape the root.
      throw new Error("Workspace path is outside the user-selected workspace.");
    }

    const entries: WorkspaceEntry[] = [];
    await walkDirectory(normalizedWorkspacePath, normalizedWorkspacePath, entries);

    let readme: string | null = null;
    for (const fileName of ["README.md", "README", "readme.md"]) {
      const readmePath = resolve(normalizedWorkspacePath, fileName);
      try {
        const readmeMetadata = await lstat(readmePath);
        if (readmeMetadata.isFile() && readmeMetadata.size <= MAX_README_BYTES) {
          readme = await readFile(readmePath, "utf8");
          break;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw error;
        }
      }
    }

    return {
      workspacePath: normalizedWorkspacePath,
      entries,
      readme
    };
  }

  /**
   * Where a path given to read_file points, before the disk is touched. Throws
   * for a path outside the workspace and for a file that usually holds secrets.
   */
  private locateFile(path: string): { readonly root: string; readonly target: string; readonly relativePath: string } {
    const root = this.allowedWorkspaceRoot;
    if (root === undefined) {
      throw new Error("Select a workspace in MCP Connector before reading files.");
    }
    const target = resolve(root, path);
    if (!isWithinWorkspace(root, target) || target === root) {
      throw new Error("That file is outside the user-selected workspace.");
    }
    const relativePath = relative(root, target).split(/[\\/]/u).join("/");
    if (namesFileStream(relativePath)) {
      throw new Error(`MCP Connector does not read ${relativePath}. On Windows a colon in a path names a hidden stream of a file.`);
    }
    const secret = secretFileReason(relativePath);
    if (secret !== null) throw new Error(`MCP Connector does not read ${relativePath}. ${secret}`);
    return { root, target, relativePath };
  }

  /**
   * What a read would touch, for showing to the user before it runs: the
   * file's path inside the workspace and the lines asked for, if any. It
   * refuses what readTextFile refuses without opening the file.
   */
  describeRead(path: string, range: ReadRange = {}): { readonly file: string; readonly lines?: string } {
    const { relativePath } = this.locateFile(path);
    const start = range.startLine ?? 1;
    if (range.maxLines !== undefined) return { file: relativePath, lines: `${start} to ${start + range.maxLines - 1}` };
    return range.startLine === undefined ? { file: relativePath } : { file: relativePath, lines: `${start} onwards` };
  }

  /**
   * Reads one text file inside the selected workspace, whole or by lines. It
   * refuses anything outside the workspace, also through a link or "..",
   * files that usually hold secrets, files over MAX_READ_FILE_BYTES, and
   * files that are not text.
   */
  async readTextFile(path: string, range: ReadRange = {}): Promise<FileText> {
    const { root, target, relativePath } = this.locateFile(path);
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = await realpath(root);
      realTarget = await realpath(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`There is no file at ${relativePath} in the workspace.`, { cause: error });
      }
      throw error;
    }
    // A link, or a link in a folder on the way, can lead out of the workspace.
    if (!isWithinWorkspace(realRoot, realTarget)) {
      throw new Error("That file is outside the user-selected workspace.");
    }
    // And a link with a harmless name can point at a secret file inside it.
    const secret = secretFileReason(relative(realRoot, realTarget));
    if (secret !== null) throw new Error(`MCP Connector does not read ${relativePath}. ${secret}`);

    const metadata = await stat(realTarget);
    if (!metadata.isFile()) {
      throw new Error(`${relativePath} is not a file. Use filesystem_inspect_workspace to list a folder.`);
    }
    const tooLarge = (size: number): Error => new Error(
      `${relativePath} is too large to read: ${size.toLocaleString("en-US")} bytes, and the limit is ${MAX_READ_FILE_BYTES.toLocaleString("en-US")}.`
    );
    if (metadata.size > MAX_READ_FILE_BYTES) throw tooLarge(metadata.size);
    const bytes = await readFile(realTarget);
    // Checked again: the file may have grown since its size was read.
    if (bytes.length > MAX_READ_FILE_BYTES) throw tooLarge(bytes.length);

    const notText = new Error(`${relativePath} is not a text file, so it cannot be read.`);
    if (bytes.includes(0)) throw notText;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw notText;
    }

    const lines = text.split(/\r?\n/u);
    // A final line break ends the last line; it does not start another.
    if (lines.at(-1) === "") lines.pop();
    const totalLines = lines.length;
    const startLine = range.startLine ?? 1;
    if (totalLines > 0 && startLine > totalLines) {
      throw new Error(`${relativePath} has ${totalLines} ${totalLines === 1 ? "line" : "lines"}, so there is no line ${startLine}.`);
    }
    const selected = lines.slice(startLine - 1, startLine - 1 + (range.maxLines ?? DEFAULT_READ_LINES));
    const endLine = selected.length === 0 ? 0 : startLine + selected.length - 1;
    return {
      path: relativePath,
      totalLines,
      startLine: selected.length === 0 ? 0 : startLine,
      endLine,
      hasMore: endLine < totalLines,
      text: selected.join("\n")
    };
  }

  resolveWorkspaceFile(workspacePath: string, relativePath: string): string {
    const normalizedWorkspacePath = assertWorkspacePath(workspacePath);
    const candidatePath = resolve(normalizedWorkspacePath, relativePath);
    if (!isWithinWorkspace(normalizedWorkspacePath, candidatePath)) {
      throw new Error("Requested file is outside the selected workspace.");
    }
    return candidatePath;
  }

  getWorkspaceDirectory(workspacePath: string): string {
    return dirname(assertWorkspacePath(workspacePath));
  }
}
