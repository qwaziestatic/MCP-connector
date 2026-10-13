import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AuditRecord,
  WorkflowPreview,
  WorkspaceSnapshot
} from "@mcp-connector/core";
import type { VsCodeContext } from "../security/vscode-context-server";
import "./styles.css";

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function App(): JSX.Element {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [approvedPreviewId, setApprovedPreviewId] = useState<string | null>(null);
  const [auditRecords, setAuditRecords] = useState<readonly AuditRecord[]>([]);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditStatus, setAuditStatus] = useState<AuditRecord["status"] | "ALL">("ALL");
  const [expandedAuditId, setExpandedAuditId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<Readonly<Record<"github" | "notion", boolean>>>({
    github: false,
    notion: false
  });
  const [mcpStatus, setMcpStatus] = useState<{
    readonly enabled: boolean;
    readonly url: string | null;
    readonly bearerToken: string | null;
  }>({ enabled: false, url: null, bearerToken: null });
  const [vscodeStatus, setVscodeStatus] = useState<{
    readonly enabled: boolean;
    readonly url: string | null;
    readonly bearerToken: string | null;
    readonly latestContext: VsCodeContext | null;
  }>({ enabled: false, url: null, bearerToken: null, latestContext: null });
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAudit = async (): Promise<void> => {
    setAuditRecords(await window.desktopApi.workflow.listAuditRecords());
  };

  const filteredAuditRecords = useMemo(() => {
    const search = auditSearch.trim().toLowerCase();
    return auditRecords.filter((record) => {
      if (auditStatus !== "ALL" && record.status !== auditStatus) return false;
      return search.length === 0
        || record.action.toLowerCase().includes(search)
        || record.target.toLowerCase().includes(search)
        || record.previewJson.toLowerCase().includes(search);
    });
  }, [auditRecords, auditSearch, auditStatus]);

  useEffect(() => {
    void Promise.all([
      refreshAudit(),
      window.desktopApi.credentials.getStatus().then(setConnectionStatus),
      window.desktopApi.mcp.getStatus().then(setMcpStatus),
      window.desktopApi.vscode.getStatus().then(setVscodeStatus)
    ]).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Unable to load audit history.");
    });
  }, []);

  const updateConnection = async (
    provider: "github" | "notion",
    connected: boolean
  ): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      if (connected) {
        await window.desktopApi.credentials.disconnect(provider);
      } else {
        await window.desktopApi.credentials.connect(provider);
      }
      setConnectionStatus(await window.desktopApi.credentials.getStatus());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : `Unable to update ${provider} connection.`);
    } finally {
      setBusy(false);
    }
  };

  const chooseWorkspace = async (): Promise<void> => {
    setError(null);
    const selectedPath = await window.desktopApi.filesystem.chooseWorkspace();
    if (selectedPath === null) return;

    setBusy(true);
    try {
      const nextSnapshot = await window.desktopApi.filesystem.inspectWorkspace(selectedPath);
      setWorkspacePath(selectedPath);
      setSnapshot(nextSnapshot);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to inspect workspace.");
    } finally {
      setBusy(false);
    }
  };

  const createNotionPreview = async (): Promise<void> => {
    if (snapshot === null || workspacePath === null) return;

    setError(null);
    setBusy(true);
    try {
      const nextPreview = await window.desktopApi.workflow.createPreview(
        "CREATE",
        "Notion project page",
        `Create a project page from ${workspacePath}`,
        {
          workspacePath,
          readme: snapshot.readme,
          fileCount: snapshot.entries.filter((entry) => entry.type === "file").length
        }
      );
      setPreview(nextPreview);
      await refreshAudit();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to create preview.");
    } finally {
      setBusy(false);
    }
  };

  const decidePreview = async (decision: "approve" | "reject"): Promise<void> => {
    if (preview === null) return;

    setError(null);
    setBusy(true);
    try {
      if (decision === "approve") {
        await window.desktopApi.workflow.approve(preview.id);
        setApprovedPreviewId(preview.id);
      } else {
        await window.desktopApi.workflow.reject(preview.id);
        setApprovedPreviewId(null);
        setPreview(null);
      }
      await refreshAudit();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to record approval decision.");
    } finally {
      setBusy(false);
    }
  };

  const updateMcp = async (enabled: boolean): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      if (enabled) {
        setMcpStatus(await window.desktopApi.mcp.stop().then(() => ({
          enabled: false,
          url: null,
          bearerToken: null
        })));
      } else {
        const started = await window.desktopApi.mcp.start();
        setMcpStatus({ enabled: true, ...started });
      }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to update MCP server.");
    } finally {
      setBusy(false);
    }
  };

  const updateVscode = async (enabled: boolean): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      if (enabled) {
        await window.desktopApi.vscode.stop();
        setVscodeStatus({ enabled: false, url: null, bearerToken: null, latestContext: null });
      } else {
        const started = await window.desktopApi.vscode.start();
        const status = await window.desktopApi.vscode.getStatus();
        setVscodeStatus({ ...status, enabled: true, ...started });
      }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to update VS Code listener.");
    } finally {
      setBusy(false);
    }
  };

  const copyValue = async (label: string, value: string | null): Promise<void> => {
    if (value === null) return;
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1800);
  };

  const executeApproved = async (): Promise<void> => {
    if (approvedPreviewId === null) return;
    setError(null);
    setBusy(true);
    try {
      await window.desktopApi.workflow.executeApproved(approvedPreviewId);
      setApprovedPreviewId(null);
      setPreview(null);
      await refreshAudit();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Unable to execute approved action.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">SECURE LOCAL ORCHESTRATOR</p>
          <h1>MCP Connector</h1>
          <p className="muted">Inspect a workspace and review every mutating action before execution.</p>
        </div>
        <button className="button secondary" onClick={() => void chooseWorkspace()} disabled={busy}>
          {busy ? "Working..." : "Choose workspace"}
        </button>
      </header>

      {error !== null && <div className="alert">{error}</div>}

      <section className="grid">
        <article className="card workspace-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">WORKSPACE</p>
              <h2>{workspacePath ?? "No workspace selected"}</h2>
            </div>
            {snapshot !== null && <span className="badge">{snapshot.entries.length} entries</span>}
          </div>
          {snapshot === null ? (
            <p className="muted">Select a directory to inspect files and README metadata locally.</p>
          ) : (
            <>
              <div className="stats">
                <div><strong>{snapshot.entries.filter((entry) => entry.type === "file").length}</strong><span>Files</span></div>
                <div><strong>{snapshot.entries.filter((entry) => entry.type === "directory").length}</strong><span>Directories</span></div>
                <div><strong>{snapshot.readme === null ? "No" : "Yes"}</strong><span>README</span></div>
              </div>
              <button className="button primary" onClick={() => void createNotionPreview()} disabled={busy}>
                Preview Notion page creation
              </button>
              <div className="file-list">
                {snapshot.entries.slice(0, 12).map((entry) => (
                  <div className="file-row" key={entry.relativePath}>
                    <span>{entry.type === "directory" ? "DIR" : "FILE"} {entry.relativePath}</span>
                    <span className="muted">{entry.type === "file" ? formatBytes(entry.sizeBytes) : ""}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </article>

        <article className="card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">HUMAN APPROVAL</p>
              <h2>Pending transaction</h2>
            </div>
            <span className="badge warning">HITL required</span>
          </div>
          {preview === null ? (
            <p className="muted">No mutating action is waiting for your decision.</p>
          ) : (
            <div className="preview">
              <div className="preview-row"><span>Action</span><strong>{preview.action}</strong></div>
              <div className="preview-row"><span>Target</span><strong>{preview.target}</strong></div>
              <p>{preview.summary}</p>
              <pre>{JSON.stringify(preview.payload, null, 2)}</pre>
              <div className="actions">
                <button className="button danger" onClick={() => void decidePreview("reject")} disabled={busy}>Reject</button>
                {approvedPreviewId === preview.id ? (
                  <button className="button approve" onClick={() => void executeApproved()} disabled={busy}>Execute approved action</button>
                ) : (
                  <button className="button approve" onClick={() => void decidePreview("approve")} disabled={busy}>Approve action</button>
                )}
              </div>
            </div>
          )}
        </article>
      </section>

      <section className="card integrations-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">CLOUD CONNECTORS</p>
            <h2>Secure provider connections</h2>
          </div>
          <span className="muted">Tokens remain in Windows-protected storage.</span>
        </div>
        <div className="integration-list">
          {(["github", "notion"] as const).map((provider) => (
            <div className="integration-row" key={provider}>
              <div>
                <strong>{provider === "github" ? "GitHub" : "Notion"}</strong>
                <p className="muted">{connectionStatus[provider] ? "Connected" : "Not connected"}</p>
              </div>
              <button
                className={`button ${connectionStatus[provider] ? "danger" : "secondary"}`}
                onClick={() => void updateConnection(provider, connectionStatus[provider])}
                disabled={busy}
              >
                {connectionStatus[provider] ? "Disconnect" : "Connect"}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="card integrations-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">MCP ENDPOINT</p>
            <h2>Local tool server</h2>
          </div>
          <span className={`badge ${mcpStatus.enabled ? "success" : ""}`}>
            {mcpStatus.enabled ? "Running" : "Stopped"}
          </span>
        </div>
        <p className="muted">Loopback-only HTTP transport protected by a per-launch bearer token.</p>
        <div className="actions endpoint-actions">
          <button className={`button ${mcpStatus.enabled ? "danger" : "secondary"}`} onClick={() => void updateMcp(mcpStatus.enabled)} disabled={busy}>
            {mcpStatus.enabled ? "Stop MCP server" : "Start MCP server"}
          </button>
        </div>
        {mcpStatus.enabled && (
          <div className="endpoint-details">
            <div className="endpoint-value"><span>Endpoint</span><code>{mcpStatus.url}</code><button className="button ghost" onClick={() => void copyValue("endpoint", mcpStatus.url)}>{copied === "endpoint" ? "Copied" : "Copy"}</button></div>
            <div className="endpoint-value"><span>Bearer token</span><code>{mcpStatus.bearerToken}</code><button className="button ghost" onClick={() => void copyValue("token", mcpStatus.bearerToken)}>{copied === "token" ? "Copied" : "Copy"}</button></div>
          </div>
        )}
      </section>

      <section className="card integrations-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">VS CODE CONTEXT</p>
            <h2>Editor context listener</h2>
          </div>
          <span className={`badge ${vscodeStatus.enabled ? "success" : ""}`}>
            {vscodeStatus.enabled ? "Running" : "Stopped"}
          </span>
        </div>
        <p className="muted">Loopback-only WebSocket listener for sanitized editor context. It cannot execute actions.</p>
        <div className="actions endpoint-actions">
          <button className={`button ${vscodeStatus.enabled ? "danger" : "secondary"}`} onClick={() => void updateVscode(vscodeStatus.enabled)} disabled={busy}>
            {vscodeStatus.enabled ? "Stop listener" : "Start listener"}
          </button>
        </div>
        {vscodeStatus.enabled && (
          <div className="endpoint-details">
            <div className="endpoint-value"><span>Endpoint</span><code>{vscodeStatus.url}</code><button className="button ghost" onClick={() => void copyValue("vscode-endpoint", vscodeStatus.url)}>{copied === "vscode-endpoint" ? "Copied" : "Copy"}</button></div>
            <div className="endpoint-value"><span>Bearer token</span><code>{vscodeStatus.bearerToken}</code><button className="button ghost" onClick={() => void copyValue("vscode-token", vscodeStatus.bearerToken)}>{copied === "vscode-token" ? "Copied" : "Copy"}</button></div>
            {vscodeStatus.latestContext !== null && <p className="muted">Latest workspace: {vscodeStatus.latestContext.workspacePath}</p>}
          </div>
        )}
      </section>

      <section className="card audit-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">AUDIT LOG</p>
            <h2>Recent decisions</h2>
          </div>
          <button className="button ghost" onClick={() => void refreshAudit()} disabled={busy}>Refresh</button>
        </div>
        <div className="audit-filters">
          <label>
            Search
            <input
              value={auditSearch}
              onChange={(event) => setAuditSearch(event.target.value)}
              placeholder="Target, action, or payload"
            />
          </label>
          <label>
            Status
            <select value={auditStatus} onChange={(event) => setAuditStatus(event.target.value as AuditRecord["status"] | "ALL")}>
              <option value="ALL">All statuses</option>
              <option value="PREVIEWED">Previewed</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="EXECUTED">Executed</option>
              <option value="FAILED">Failed</option>
            </select>
          </label>
        </div>
        {auditRecords.length === 0 ? <p className="muted">No actions have been recorded yet.</p> : filteredAuditRecords.length === 0 ? (
          <p className="muted">No audit records match the current filters.</p>
        ) : (
          <div className="audit-list">
            {filteredAuditRecords.slice(0, 50).map((record) => (
              <div className="audit-entry" key={record.id}>
                <button className="audit-row" onClick={() => setExpandedAuditId(expandedAuditId === record.id ? null : record.id)}>
                <span className={`status ${record.status.toLowerCase()}`}>{record.status}</span>
                <strong>{record.action}</strong>
                <span>{record.target}</span>
                <time>{formatDate(record.createdAt)}</time>
                </button>
                {expandedAuditId === record.id && (
                  <pre className="audit-details">{record.previewJson}</pre>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Renderer root element was not found.");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
