import { useEffect, useRef, useState } from "react";
import type { ConnectorView } from "../connection/connector-hub";
import type { SignInPrompt } from "../security/sign-in-flow";

/** The main process's message, without Electron's "Error invoking remote method" prefix. */
export function ipcErrorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  return cause.message.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "");
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(value));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

interface ConnectionsCardProps {
  /** Shows a message in the window's alert, or clears it. */
  readonly onError: (message: string | null) => void;
  readonly copyText: (label: string, value: string) => Promise<void>;
  /** The label of the value just copied, for the button's "Copied" state. */
  readonly copied: string | null;
}

/** Every connector the app offers, from the definitions the main process reports. */
export function ConnectionsCard({ onError, copyText, copied }: ConnectionsCardProps): JSX.Element {
  const api = window.desktopApi.connectors;
  const [connectors, setConnectors] = useState<readonly ConnectorView[]>([]);
  // What each connector's sign-in currently shows, while the user signs in.
  const [prompts, setPrompts] = useState<Readonly<Record<string, SignInPrompt>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const cancelled = useRef(new Set<string>());

  const refresh = async (): Promise<void> => setConnectors(await api.list());

  useEffect(() => {
    // Loaded once; every change below refreshes it.
    void refresh().catch((cause: unknown) => onError(ipcErrorMessage(cause, "Unable to load the connectors.")));
  }, []);

  const setPrompt = (id: string, prompt: SignInPrompt | null): void => {
    setPrompts((current) => {
      const next = { ...current };
      if (prompt === null) delete next[id];
      else next[id] = prompt;
      return next;
    });
  };

  const connect = async (connector: ConnectorView): Promise<void> => {
    onError(null);
    cancelled.current.delete(connector.id);
    setBusy(connector.id);
    try {
      setPrompt(connector.id, await api.startSignIn(connector.id));
    } catch (cause: unknown) {
      onError(ipcErrorMessage(cause, `Unable to start signing in to ${connector.name}.`));
      return;
    } finally {
      setBusy(null);
    }
    try {
      await api.finishSignIn(connector.id);
      await refresh();
    } catch (cause: unknown) {
      if (!cancelled.current.has(connector.id)) onError(ipcErrorMessage(cause, `${connector.name} sign-in failed.`));
    } finally {
      setPrompt(connector.id, null);
    }
  };

  const openPage = async (connector: ConnectorView, prompt: SignInPrompt): Promise<void> => {
    if (prompt.kind !== "code") return;
    try {
      await copyText(`code:${connector.id}`, prompt.userCode);
    } catch {
      // The code is on screen if the clipboard is unavailable.
    }
    try {
      await api.openSignInPage(connector.id);
    } catch (cause: unknown) {
      onError(ipcErrorMessage(cause, `Unable to open ${connector.name}.`));
    }
  };

  const cancel = async (connector: ConnectorView): Promise<void> => {
    cancelled.current.add(connector.id);
    await api.cancelSignIn(connector.id);
  };

  const disconnect = async (connector: ConnectorView): Promise<void> => {
    onError(null);
    setBusy(connector.id);
    try {
      await api.disconnect(connector.id);
      await refresh();
    } catch (cause: unknown) {
      onError(ipcErrorMessage(cause, `Unable to disconnect ${connector.name}.`));
    } finally {
      setBusy(null);
    }
  };

  const saveSetting = async (connector: ConnectorView, key: string, value: string): Promise<void> => {
    onError(null);
    const draftKey = `${connector.id}:${key}`;
    try {
      const updated = await api.setSetting(connector.id, key, value);
      setConnectors((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      setDrafts((current) => ({ ...current, [draftKey]: "" }));
    } catch (cause: unknown) {
      onError(ipcErrorMessage(cause, `Unable to save the ${connector.name} setting.`));
    }
  };

  return (
    <section className="card integrations-card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">CLOUD CONNECTORS</p>
          <h2>Secure provider connections</h2>
        </div>
        <span className="muted">Tokens remain in Windows-protected storage.</span>
      </div>
      <div className="integration-list">
        {connectors.map((connector) => {
          const prompt = prompts[connector.id];
          const status = prompt?.kind === "code"
            ? `Waiting for you to approve on ${hostOf(prompt.verificationUri)}`
            : prompt?.kind === "browser"
              ? "Waiting for you to allow access in your browser"
              : connector.connected ? "Connected" : "Not connected";
          return (
            <div className="connector" key={connector.id}>
              <div className="integration-row">
                <div>
                  <strong>{connector.name}</strong>
                  <p className="muted">{status}</p>
                  <p className="muted connector-description">{connector.description}</p>
                </div>
                <button
                  className={`button ${connector.connected ? "danger" : "secondary"}`}
                  onClick={() => void (connector.connected ? disconnect(connector) : connect(connector))}
                  disabled={busy !== null || prompt !== undefined}
                >
                  {connector.connected ? "Disconnect" : "Connect"}
                </button>
              </div>
              {prompt?.kind === "code" && (
                <div className="device-code" role="status">
                  <div>
                    <p>Enter this code on {connector.name} to connect your account:</p>
                    <code className="device-code-value">{prompt.userCode}</code>
                    <p className="muted">The code works until {formatTime(prompt.expiresAt)}.</p>
                  </div>
                  <div className="actions">
                    <button className="button primary" onClick={() => void openPage(connector, prompt)}>
                      {copied === `code:${connector.id}` ? "Code copied" : `Copy code and open ${connector.name}`}
                    </button>
                    <button className="button ghost" onClick={() => void cancel(connector)}>Cancel</button>
                  </div>
                </div>
              )}
              {prompt?.kind === "browser" && (
                <div className="device-code" role="status">
                  <div>
                    <p>Finish in your browser: choose what MCP Connector may use, then allow access.</p>
                    <p className="muted">MCP Connector notices as soon as you allow access.</p>
                  </div>
                  <div className="actions">
                    <button className="button ghost" onClick={() => void cancel(connector)}>Cancel</button>
                  </div>
                </div>
              )}
              {connector.settings.map((setting) => {
                const draftKey = `${connector.id}:${setting.key}`;
                const draft = drafts[draftKey] ?? "";
                const inputId = `setting-${connector.id}-${setting.key}`;
                return (
                  <div className="connector-setting" key={setting.key}>
                    <label htmlFor={inputId}>{setting.label}</label>
                    <div className="connector-setting-row">
                      <input
                        id={inputId}
                        value={draft}
                        placeholder={setting.value ?? setting.placeholder}
                        onChange={(event) => {
                          const value = event.target.value;
                          setDrafts((current) => ({ ...current, [draftKey]: value }));
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && draft.trim().length > 0) void saveSetting(connector, setting.key, draft);
                        }}
                      />
                      <button
                        className="button secondary"
                        disabled={draft.trim().length === 0}
                        onClick={() => void saveSetting(connector, setting.key, draft)}
                      >
                        Save
                      </button>
                      {setting.source === "app" && (
                        <button className="button ghost" onClick={() => void saveSetting(connector, setting.key, "")}>Clear</button>
                      )}
                    </div>
                    <p className="muted">
                      {setting.value === null
                        ? `Not set. ${setting.help}`
                        : `Set to ${setting.value}${setting.source === "environment" ? " by an environment variable" : ""}. ${setting.help}`}
                    </p>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
