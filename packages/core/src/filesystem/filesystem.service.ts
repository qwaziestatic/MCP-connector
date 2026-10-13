import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export interface WorkspaceEntry {
  readonly relativePath: string;
  readonly type: "file" | "directory";
  readonly sizeBytes: number;
}

export interface WorkspaceSnapshot {
  readonly workspacePath: string;
  readonly entries: readonly WorkspaceEntry[];
  readonly readme: string | null;
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

function isWithinWorkspace(workspacePath: string, candidatePath: string): boolean {
  const relativePath = relative(workspacePath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
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
      throw new Error(`Symbolic links are not allowed in workspace: ${entry.name}`);
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
