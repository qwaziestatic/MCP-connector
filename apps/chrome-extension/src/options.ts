// The options page: pairing with MCP Connector. The key goes straight to the
// background worker and is never shown again.
import { ask, button, element, messageOf } from "./ask.ts";
import { DEFAULT_PORT, RELEASES_URL } from "./lib/mcp-client.ts";
import { describeStatus } from "./lib/status.ts";
import type { ConnectionStatus } from "./lib/worker.ts";

const keyInput = document.getElementById("browser-key") as HTMLInputElement;
const portInput = document.getElementById("port") as HTMLInputElement;
const form = document.getElementById("pairing") as HTMLFormElement;
const statusLine = document.getElementById("status") as HTMLElement;
const actions = document.getElementById("status-actions") as HTMLElement;
const saved = document.getElementById("saved") as HTMLElement;

function show(status: ConnectionStatus): void {
  const line = describeStatus(status);
  statusLine.textContent = line.text;
  statusLine.className = line.ok ? "status ok" : "status problem";
  portInput.value = String(status.port);
  saved.textContent = status.state === "not-paired"
    ? "No key is saved."
    : "A key is saved. It is not shown here; paste a key only to replace it.";
  actions.replaceChildren();
  if (line.actions.includes("retry")) actions.append(button("Check again", () => void check()));
  if (line.actions.includes("releases")) {
    const link = element("a", { text: "MCP Connector's Releases page" });
    link.href = RELEASES_URL;
    link.target = "_blank";
    link.rel = "noreferrer";
    actions.append(link);
  }
  if (status.state !== "not-paired") {
    actions.append(button("Forget the key", () => void run(() => ask<ConnectionStatus>({ type: "forget-pairing" })), "quiet"));
  }
}

async function run(action: () => Promise<ConnectionStatus>): Promise<void> {
  statusLine.textContent = "Checking…";
  statusLine.className = "status";
  try {
    show(await action());
  } catch (error) {
    statusLine.textContent = messageOf(error);
    statusLine.className = "status problem";
  }
}

const check = (): Promise<void> => run(() => ask<ConnectionStatus>({ type: "get-status" }));

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const browserKey = keyInput.value;
  const port = Number(portInput.value);
  keyInput.value = "";
  void run(() => ask<ConnectionStatus>({ type: "save-pairing", browserKey, port }));
});

portInput.value = String(DEFAULT_PORT);
void check();
