// Launches the packaged app and checks that its window, database, and local
// servers work. CI only builds the code, so without this a startup crash in the
// packaged app goes unnoticed.
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.argv[2] ?? join(root, "release", "win-unpacked", "MCP Connector.exe");
const startupTimeoutMs = 90_000;

// A throwaway profile keeps the database and settings out of the real user-data folder.
const userDataDir = await mkdtemp(join(tmpdir(), "mcp-connector-smoke-"));
const env = { ...process.env };
// VS Code and some shells set this, which would make Electron run as plain Node.js.
delete env.ELECTRON_RUN_AS_NODE;

const app = spawn(executable, [`--user-data-dir=${userDataDir}`, "--remote-debugging-port=0"], {
  env,
  stdio: ["ignore", "pipe", "pipe"]
});
let appOutput = "";
let exitCode;
app.stdout.on("data", (chunk) => { appOutput += chunk; });
app.stderr.on("data", (chunk) => { appOutput += chunk; });
app.on("exit", (code) => { exitCode = code; });
app.on("error", (error) => { appOutput += `\n${error.message}`; exitCode = -1; });

async function waitForPage() {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline && exitCode === undefined) {
    try {
      // With port 0, Chromium writes the port it picked to this file.
      const [port] = (await readFile(join(userDataDir, "DevToolsActivePort"), "utf8")).split("\n");
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page !== undefined) return page;
    } catch {
      // Not ready yet.
    }
    await delay(500);
  }
  throw new Error(exitCode === undefined
    ? "The app did not open its window. A startup error may be showing in a dialog."
    : `The app exited during startup with code ${exitCode}.`);
}

async function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    async evaluate(expression) {
      const id = ++nextId;
      const response = await new Promise((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true }
        }));
      });
      const { result, exceptionDetails } = response.result;
      if (exceptionDetails !== undefined) {
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      }
      return result.value;
    },
    close: () => socket.close()
  };
}

async function waitForRender(page) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate("document.readyState === 'complete' && document.querySelector('h1') !== null")) return;
    await delay(250);
  }
  throw new Error("The window loaded but the app did not render.");
}

const checks = [
  ["window loads", async (page) => {
    await waitForRender(page);
    const title = await page.evaluate("document.title");
    if (title !== "MCP Connector") throw new Error(`Unexpected window title: ${JSON.stringify(title)}.`);
  }],
  ["renderer has no Node.js access", async (page) => {
    if (!await page.evaluate("typeof require === 'undefined' && typeof process === 'undefined'")) {
      throw new Error("Node.js globals are exposed to the renderer.");
    }
  }],
  ["database loads pending approvals and audit log", async (page) => {
    await page.evaluate("window.desktopApi.workflow.listPending()");
    await page.evaluate("window.desktopApi.workflow.listAuditRecords()");
  }],
  ["MCP server starts, requires its token, and stops", async (page) => {
    const server = await page.evaluate("window.desktopApi.mcp.start()");
    try {
      const response = await fetch(server.url, { method: "POST", body: "{}" });
      if (response.status !== 401) throw new Error(`Unauthenticated request returned ${response.status}.`);
    } finally {
      await page.evaluate("window.desktopApi.mcp.stop()");
    }
  }],
  ["VS Code listener starts and stops", async (page) => {
    await page.evaluate("window.desktopApi.vscode.start()");
    await page.evaluate("window.desktopApi.vscode.stop()");
  }]
];

const failures = [];
try {
  const page = await connect((await waitForPage()).webSocketDebuggerUrl);
  for (const [name, check] of checks) {
    try {
      await check(page);
      console.log(`  ok    ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`  FAIL  ${name}: ${error.message}`);
    }
  }
  page.close();
} catch (error) {
  failures.push("startup");
  console.log(`  FAIL  startup: ${error.message}`);
} finally {
  if (exitCode === undefined) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(app.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      app.kill();
    }
    await new Promise((resolve) => (exitCode === undefined ? app.once("exit", resolve) : resolve()));
  }
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

if (failures.length > 0) {
  console.log("\nApp output:\n" + (appOutput.trim() || "(none)"));
  process.exitCode = 1;
} else {
  console.log("Packaged app smoke test passed.");
}
