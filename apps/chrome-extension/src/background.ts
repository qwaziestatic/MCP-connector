// The background service worker. It holds the browser key and is the only part
// that talks to MCP Connector, at http://127.0.0.1:<port>/mcp. What it will do
// is in lib/worker.ts; this file connects that to Chrome.
import { isExtensionPage } from "./lib/messages.ts";
import { createWorker, reply, type KeyValueStore } from "./lib/worker.ts";

function store(area: chrome.storage.StorageArea): KeyValueStore {
  return {
    get: async (key) => (await area.get(key))[key],
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key)
  };
}

// chrome.storage.local holds the browser key, and content scripts can read it
// unless told otherwise. This keeps it to the extension's own pages and worker.
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
// Clicking the extension's icon opens the side panel.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const worker = createWorker({
  saved: store(chrome.storage.local),
  session: store(chrome.storage.session)
});
const extensionUrl = chrome.runtime.getURL("");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the side panel and the options page are answered. The content script
  // runs inside the ChatGPT page, so whatever that page makes it send, nothing
  // here runs for it.
  if (!isExtensionPage(sender, chrome.runtime.id, extensionUrl)) return false;
  void reply(() => worker.handle(message)).then(sendResponse);
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void worker.forgetTab(tabId);
});

chrome.runtime.onInstalled.addListener((details) => {
  // A new install has no key yet; the options page is where it goes.
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
});
