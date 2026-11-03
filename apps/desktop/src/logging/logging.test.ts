import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileLogger, MAX_LOG_BYTES } from "./file-logger";
import { describeStartupError } from "./startup-error";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createFileLogger", () => {
  it("writes timestamped lines, including error stacks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-log-"));
    directories.push(directory);
    const logger = createFileLogger(join(directory, "logs"), () => new Date("2026-11-03T12:00:00.000Z"));

    logger.info("Starting");
    logger.error("Startup failed.", new Error("disk full"));
    const text = await readFile(logger.path, "utf8");

    expect(text).toContain("2026-11-03T12:00:00.000Z INFO Starting\n");
    expect(text).toMatch(/ERROR Startup failed\. Error: disk full\n\s+at /u);
  });

  it("starts a new file when the old one is too large", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-log-"));
    directories.push(directory);
    await writeFile(join(directory, "main.log"), "x".repeat(MAX_LOG_BYTES + 1));

    const logger = createFileLogger(directory);
    logger.info("fresh");

    expect(await readFile(logger.path, "utf8")).toMatch(/INFO fresh\n$/u);
    expect((await stat(join(directory, "main.old.log"))).size).toBe(MAX_LOG_BYTES + 1);
  });

  it("never throws, even when it cannot write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-log-"));
    directories.push(directory);
    await writeFile(join(directory, "not-a-folder"), "");
    const logger = createFileLogger(join(directory, "not-a-folder"));

    expect(() => logger.error("still fine", new Error("x"))).not.toThrow();
  });
});

describe("describeStartupError", () => {
  it.each([
    [new Error("Cannot find module '.prisma/client/default'"), "Reinstall the latest version"],
    [new Error("The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127."), "Reinstall the latest version"],
    [Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }), "Another copy of MCP Connector"],
    [new Error("Raw query failed. Code: `SQLITE_NOTADB`. Message: `file is not a database`"), "move mcp-connector.db out of C:\\data"],
    [Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" }), "cannot open its data folder (C:\\data)"],
    [new Error("Something else\nwith a second line"), "unexpected error"]
  ])("explains %s", (error, advice) => {
    const description = describeStartupError(error, "C:\\data");

    expect(description.title).toBe("MCP Connector could not start");
    expect(description.message).toContain(advice);
    expect(description.message).toContain(`Error: ${error.message.split("\n")[0]}`);
    expect(description.message).not.toContain("second line");
  });

  it("shows the reason from a Prisma error, which comes last", () => {
    const error = Object.assign(
      new Error("\nInvalid `prisma.$executeRaw()` invocation:\n\n\nunable to open database file"),
      { code: "P2010" }
    );

    expect(describeStartupError(error, "/data").message)
      .toMatch(/cannot open its data folder \(\/data\)[\s\S]*Error: unable to open database file$/u);
  });
});
