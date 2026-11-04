// Launches the packaged app and checks that its window, database, and local
// servers work. CI only builds the code, so without this a startup crash in the
// packaged app goes unnoticed.
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.argv[2] ?? join(root, "release", "win-unpacked", "MCP Connector.exe");
const startupTimeoutMs = 90_000;

// A throwaway profile keeps the database and settings out of the real user-data folder.
const userDataDir = await mkdtemp(join(tmpdir(), "mcp-connector-smoke-"));
// Port 0 picks free ports, so the test never collides with a running copy of the app.
await writeFile(join(userDataDir, "settings.json"), JSON.stringify({ mcpPort: 0, vscodePort: 0 }));
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

/** A new profile's key reaches the disk about ten seconds after the first launch. */
async function readVaultKey() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const key = JSON.parse(await readFile(join(userDataDir, "Local State"), "utf8")).os_crypt?.encrypted_key;
      if (key !== undefined) return key;
    } catch {
      // Not written yet.
    }
    await delay(500);
  }
  throw new Error("The app did not save its encryption key.");
}

/** Runs a second copy with --mcp-stdio, sends one request, and returns the answer. */
async function requestThroughStdio(request) {
  const relay = spawn(executable, [`--user-data-dir=${userDataDir}`, "--mcp-stdio"], {
    env,
    stdio: ["pipe", "pipe", "ignore"]
  });
  const exited = new Promise((resolve) => relay.once("exit", resolve));
  try {
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The relay did not answer.")), 30_000);
      relay.once("exit", (code) => reject(new Error(`The relay exited with code ${code} before answering.`)));
      createInterface({ input: relay.stdout }).on("line", (line) => {
        // On Windows, Electron itself prints one blank line before the app starts.
        if (line.trim().length === 0) return;
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
      relay.stdin.write(`${JSON.stringify(request)}\n`);
    });
    relay.stdin.end();
    const code = await Promise.race([exited, delay(10_000).then(() => "still running")]);
    if (code !== 0) throw new Error(`After stdin closed, the relay's exit status was: ${code}.`);
    return answer;
  } finally {
    relay.kill();
  }
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" }
  }
};

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
  ["Copy buttons may write the clipboard; reading it stays denied", async (page) => {
    // Only asks for the permissions, so it never touches the real clipboard.
    const query = (name) => page.evaluate(`navigator.permissions.query({ name: "${name}" }).then((p) => p.state)`);
    const [write, read] = [await query("clipboard-write"), await query("clipboard-read")];
    if (write !== "granted") throw new Error(`clipboard-write is "${write}", so every Copy button fails.`);
    if (read === "granted") throw new Error("The renderer can read the clipboard.");
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
  ["stdio relay says when the server is stopped, reaches it when running, and keeps the vault key", async (page) => {
    // This runs before a new profile's key reaches the disk, which is when a
    // relay sharing the profile could replace it.
    const stopped = await requestThroughStdio(initialize);
    if (!/not running/u.test(stopped.error?.message ?? "")) {
      throw new Error(`Unexpected answer with the server stopped: ${JSON.stringify(stopped)}.`);
    }
    const key = await readVaultKey();
    await page.evaluate("window.desktopApi.mcp.start()");
    try {
      const answer = await requestThroughStdio(initialize);
      if (answer.result?.serverInfo?.name !== "mcp-connector") {
        throw new Error(`Unexpected answer: ${JSON.stringify(answer)}.`);
      }
    } finally {
      await page.evaluate("window.desktopApi.mcp.stop()");
    }
    if (await readVaultKey() !== key) throw new Error("The relay replaced the app's encryption key.");
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
