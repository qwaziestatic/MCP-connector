import { useEffect, useState } from "react";
import type { ExternalServerItem } from "../connection/external-server-store";
import { ipcErrorMessage } from "./connections-card";

type Approval = ExternalServerItem["approval"];

const EXAMPLE = `{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Projects"]
    }
  }
}`;

const approvalLabels: Readonly<Record<Approval, string>> = {
  changes: "Ask before tools that change things",
  all: "Ask before every tool"
};

function statusLine(server: ExternalServerItem): string {
  if (server.status === "connecting") return "Connecting…";
  if (server.status === "failed") return `Could not connect. ${server.message ?? ""}`.trim();
  const asking = server.tools.filter((tool) => tool.asksForApproval).length;
  return `Connected · ${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`
    + (asking > 0 ? `, ${asking} ${asking === 1 ? "asks" : "ask"} for approval` : "");
}

interface ExternalServersCardProps {
  readonly onError: (message: string | null) => void;
}

/** Other MCP servers the user added; their tools reach agents through MCP Connector's approvals. */
export function ExternalServersCard({ onError }: ExternalServersCardProps): JSX.Element {
  const api = window.desktopApi.external;
  const [servers, setServers] = useState<readonly ExternalServerItem[]>([]);
  const [setup, setSetup] = useState("");
  const [approval, setApproval] = useState<Approval>("changes");
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.list().then(setServers).catch((cause: unknown) => onError(ipcErrorMessage(cause, "Unable to load the MCP servers.")));
    return api.subscribe(setServers);
    // Subscribed once for the window's lifetime.
  }, []);

  const run = async (action: () => Promise<readonly ExternalServerItem[]>, fallback: string): Promise<boolean> => {
    onError(null);
    setBusy(true);
    try {
      setServers(await action());
      return true;
    } catch (cause: unknown) {
      onError(ipcErrorMessage(cause, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (): Promise<void> => {
    if (await run(() => api.add(setup, approval), "Unable to add the server.")) setSetup("");
  };

  const remove = async (server: ExternalServerItem): Promise<void> => {
    // Two clicks, so a stray click cannot remove a server and its saved keys.
    if (confirmingRemove !== server.id) {
      setConfirmingRemove(server.id);
      return;
    }
    setConfirmingRemove(null);
    await run(() => api.remove(server.id), `Unable to remove ${server.name}.`);
  };

  return (
    <section className="card integrations-card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">OTHER MCP SERVERS</p>
          <h2>Tools from other MCP servers</h2>
        </div>
        <span className="muted">Their keys stay in your system&apos;s protected storage.</span>
      </div>
      <p className="muted">
        Agents see these servers&apos; tools through MCP Connector, as &lt;server&gt;__&lt;tool&gt;. Tools a server
        marks read-only run at once; every other call waits for your approval here, like MCP Connector&apos;s own.
      </p>
      <div className="integration-list">
        {servers.map((server) => (
          <div className="connector" key={server.id}>
            <div className="integration-row">
              <div className="external-server-summary">
                <strong>{server.name}</strong>
                <p className={`muted${server.status === "failed" ? " external-server-failed" : ""}`}>{statusLine(server)}</p>
                <p className="muted connector-description"><code>{server.address}</code></p>
                {server.secretNames.length > 0 && (
                  <p className="muted connector-description">Kept in the vault: {server.secretNames.join(", ")}</p>
                )}
                {server.tools.length > 0 && (
                  <p className="muted connector-description external-server-tools">
                    {server.tools.map((tool) => `${tool.name}${tool.asksForApproval ? " (asks)" : ""}`).join(" · ")}
                  </p>
                )}
              </div>
              <div className="actions external-server-actions">
                <select
                  aria-label={`When to ask before ${server.name}'s tools run`}
                  value={server.approval}
                  disabled={busy}
                  onChange={(event) => void run(() => api.setApproval(server.id, event.target.value as Approval), "Unable to change the setting.")}
                >
                  {(Object.keys(approvalLabels) as Approval[]).map((mode) => <option key={mode} value={mode}>{approvalLabels[mode]}</option>)}
                </select>
                <button className="button ghost" disabled={busy || server.status === "connecting"} onClick={() => void run(() => api.reconnect(server.id), `Unable to reconnect ${server.name}.`)}>
                  Reconnect
                </button>
                <button className="button danger" disabled={busy} onClick={() => void remove(server)}>
                  {confirmingRemove === server.id ? "Click again to remove" : "Remove"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="connector-setting external-server-add">
        <label htmlFor="external-server-setup">Add a server</label>
        <textarea
          id="external-server-setup"
          rows={7}
          value={setup}
          placeholder={EXAMPLE}
          spellCheck={false}
          onChange={(event) => setSetup(event.target.value)}
        />
        <p className="muted">
          Paste the &quot;mcpServers&quot; block from the server&apos;s README. MCP Connector starts the command in it,
          so add only servers you trust. Servers started with npx need Node.js installed.
        </p>
        <div className="connector-setting-row">
          <select aria-label="When to ask before the new server's tools run" value={approval} onChange={(event) => setApproval(event.target.value as Approval)}>
            {(Object.keys(approvalLabels) as Approval[]).map((mode) => <option key={mode} value={mode}>{approvalLabels[mode]}</option>)}
          </select>
          <button className="button secondary" disabled={busy || setup.trim().length === 0} onClick={() => void add()}>Add server</button>
        </div>
      </div>
    </section>
  );
}
