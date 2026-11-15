import { useEffect, useState } from "react";
import type { WebChatStatus } from "../connection/connection-manager";
import { ipcErrorMessage } from "./connections-card";

interface WebChatsCardProps {
  readonly onError: (message: string | null) => void;
  readonly copyText: (label: string, value: string) => Promise<void>;
  /** The label of the value just copied, for the button's "Copied" state. */
  readonly copied: string | null;
  /** The MCP server, which the browser extension talks to. */
  readonly mcp: { readonly enabled: boolean; readonly url: string | null };
}

function portOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).port;
  } catch {
    return null;
  }
}

/** The browser extension's key, which web chats use. It is separate from the agents' token. */
export function WebChatsCard({ onError, copyText, copied, mcp }: WebChatsCardProps): JSX.Element {
  const api = window.desktopApi.webChats;
  const [status, setStatus] = useState<WebChatStatus>({ browserKey: null, askBeforeReads: true });
  // Two clicks, so a stray click cannot cut off the extension.
  const [confirming, setConfirming] = useState<"new" | "off" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.getStatus().then(setStatus).catch((cause: unknown) => onError(ipcErrorMessage(cause, "Unable to load the web chat settings.")));
    // Loaded once; every change below returns the new status.
  }, []);

  const run = async (action: () => Promise<WebChatStatus>, fallback: string): Promise<void> => {
    onError(null);
    setConfirming(null);
    setBusy(true);
    try {
      setStatus(await action());
    } catch (cause: unknown) {
      onError(ipcErrorMessage(cause, fallback));
      // A change can take effect and still report a problem, so show what is true now.
      await api.getStatus().then(setStatus).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const newKey = (): void => {
    if (status.browserKey !== null && confirming !== "new") {
      setConfirming("new");
      return;
    }
    void run(() => api.newKey(), "Unable to create a browser key.");
  };

  const turnOff = (): void => {
    if (confirming !== "off") {
      setConfirming("off");
      return;
    }
    void run(() => api.turnOff(), "Unable to turn off web chats.");
  };

  const port = portOf(mcp.url);

  return (
    <section className="card integrations-card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">WEB CHATS</p>
          <h2>Browser extension key</h2>
        </div>
        <span className={`badge ${status.browserKey === null ? "" : "success"}`}>
          {status.browserKey === null ? "Off" : "On"}
        </span>
      </div>
      <p className="muted">
        The MCP Connector browser extension lets a web chat, such as ChatGPT, ask for your tools. It uses its own
        key, separate from your agents&apos; token, so you can replace it or turn it off without setting up any
        agent again. Whatever a web chat asks to change waits for your approval here, like an agent&apos;s request.
      </p>
      {status.browserKey === null ? (
        <div className="actions endpoint-actions">
          <button className="button secondary" onClick={newKey} disabled={busy}>Create key</button>
        </div>
      ) : (
        <div className="endpoint-details">
          <div className="endpoint-value">
            <span>Browser key</span>
            <code>{status.browserKey}</code>
            <button className="button ghost" onClick={() => void copyText("browser-key", status.browserKey ?? "")}>
              {copied === "browser-key" ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="endpoint-value">
            <span>Port</span>
            <code>{port ?? "Chosen when the MCP server starts"}</code>
            <span>{mcp.enabled ? "MCP server running" : "Start the MCP server so the extension can connect"}</span>
          </div>
          <div className="endpoint-value">
            <span>Key</span>
            <span className="muted">
              {confirming === "new"
                ? "The extension will stop working until you paste the new key into it. Click again to confirm."
                : confirming === "off"
                  ? "Web chats will be refused until you create a new key. Click again to confirm."
                  : "Paste the key and the port into the extension's options. Agents are not affected by either button."}
            </span>
            <div className="key-actions">
              <button className={`button ${confirming === "new" ? "danger" : "ghost"}`} onClick={newKey} disabled={busy}>
                {confirming === "new" ? "Confirm new key" : "New key"}
              </button>
              <button className={`button ${confirming === "off" ? "danger" : "ghost"}`} onClick={turnOff} disabled={busy}>
                {confirming === "off" ? "Confirm turn off" : "Turn off"}
              </button>
            </div>
          </div>
        </div>
      )}
      <label className="checkbox-setting">
        <input
          type="checkbox"
          checked={status.askBeforeReads}
          disabled={busy}
          onChange={(event) => void run(() => api.setAskBeforeReads(event.target.checked), "Unable to change the setting.")}
        />
        Ask before web chats read anything
      </label>
      <p className="muted">
        {status.askBeforeReads
          ? "On: a web chat's read-only requests, such as listing your files, also wait for your approval, and run once, exactly as approved."
          : "Off: a web chat's read-only requests are answered at once. Changes still wait for your approval."}
      </p>
    </section>
  );
}
