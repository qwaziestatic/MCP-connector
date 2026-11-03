// Turns a startup failure into a message a user can act on.

export interface StartupErrorDescription {
  readonly title: string;
  readonly message: string;
}

export function describeStartupError(error: unknown, userDataPath: string): StartupErrorDescription {
  const text = error instanceof Error ? `${error.message} ${(error as NodeJS.ErrnoException).code ?? ""}` : String(error);
  const lines = (error instanceof Error ? error.message : String(error))
    .split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  // Prisma errors start with "Invalid `prisma.x()` invocation:" and give the
  // reason on the last line, so prefer that line when the first one is a heading.
  const summary = (lines[0]?.endsWith(":") === true ? lines.at(-1) : lines[0]) ?? "";

  let advice: string;
  if (/Cannot find module ['"]?\.prisma\/client|NODE_MODULE_VERSION|compiled against a different Node\.js version|better_sqlite3\.node|invalid ELF header|not a valid Win32 application/iu.test(text)) {
    advice = "Part of MCP Connector is missing or was built for a different version. "
      + "Reinstall the latest version of MCP Connector.";
  } else if (/SQLITE_NOTADB|SQLITE_CORRUPT|file is not a database|database disk image is malformed/iu.test(text)) {
    advice = "MCP Connector's database file is damaged. Close the app, move mcp-connector.db out of "
      + `${userDataPath}, and start MCP Connector again: it creates a new, empty database. `
      + "Your saved approvals and audit history stay in the file you moved.";
  } else if (/SQLITE_BUSY|database is locked/iu.test(text)) {
    advice = "MCP Connector's database is in use. Another copy of MCP Connector may still be running: "
      + "close it and try again.";
  } else if (/EACCES|EPERM|SQLITE_READONLY|SQLITE_CANTOPEN|unable to open database/iu.test(text)) {
    advice = `MCP Connector cannot open its data folder (${userDataPath}). `
      + "Check that the folder exists and that you are allowed to write to it.";
  } else {
    advice = "MCP Connector hit an unexpected error while starting.";
  }

  return {
    title: "MCP Connector could not start",
    message: summary.length > 0 ? `${advice}\n\nError: ${summary}` : advice
  };
}
