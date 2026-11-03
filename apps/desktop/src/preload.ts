import { contextBridge, ipcRenderer } from "electron";
import type { WorkflowPreviewState } from "@mcp-connector/core";
import type { DesktopApi } from "./shared/desktop-api";

const desktopApi: DesktopApi = {
  app: {
    getVersion: () => ipcRenderer.invoke("app:get-version") as Promise<string>,
    getStartupProblems: () => ipcRenderer.invoke("app:get-startup-problems") as Promise<readonly string[]>
  },
  updater: {
    getStatus: () => ipcRenderer.invoke("updater:get-status"),
    check: () => ipcRenderer.invoke("updater:check"),
    download: () => ipcRenderer.invoke("updater:download"),
    quitAndInstall: () => ipcRenderer.invoke("updater:quit-and-install")
  },
  filesystem: {
    chooseWorkspace: () =>
      ipcRenderer.invoke("filesystem:choose-workspace") as Promise<string | null>,
    inspectWorkspace: (workspacePath) =>
      ipcRenderer.invoke("filesystem:inspect-workspace", workspacePath),
    getSelectedWorkspace: () =>
      ipcRenderer.invoke("filesystem:get-selected-workspace") as Promise<string | null>
  },
  workflow: {
    createPreview: (action, target, summary, payload) =>
      ipcRenderer.invoke("workflow:create-preview", action, target, summary, payload),
    approve: (previewId) => ipcRenderer.invoke("workflow:approve", previewId),
    reject: (previewId) => ipcRenderer.invoke("workflow:reject", previewId),
    listPending: () => ipcRenderer.invoke("workflow:list-pending"),
    subscribe: (listener) => {
      const callback = (_event: Electron.IpcRendererEvent, previews: readonly WorkflowPreviewState[]) => listener(previews);
      ipcRenderer.on("workflow:changed", callback);
      return () => ipcRenderer.removeListener("workflow:changed", callback);
    },
    createNotionPagePreview: (title, markdown) =>
      ipcRenderer.invoke("notion:create-page-preview", title, markdown),
    executeApproved: (previewId) => ipcRenderer.invoke("workflow:execute-approved", previewId),
    listAuditRecords: () => ipcRenderer.invoke("workflow:list-audit-records")
  },
  credentials: {
    getStatus: () => ipcRenderer.invoke("credentials:get-status"),
    connect: (provider) => ipcRenderer.invoke("credentials:connect", provider),
    disconnect: (provider) => ipcRenderer.invoke("credentials:disconnect", provider)
  },
  mcp: {
    getStatus: () => ipcRenderer.invoke("mcp:get-status"),
    start: () => ipcRenderer.invoke("mcp:start"),
    stop: () => ipcRenderer.invoke("mcp:stop"),
    regenerateToken: () => ipcRenderer.invoke("mcp:regenerate-token"),
    getAgentConfigs: () => ipcRenderer.invoke("mcp:get-agent-configs")
  },
  vscode: {
    getStatus: () => ipcRenderer.invoke("vscode:get-status"),
    start: () => ipcRenderer.invoke("vscode:start"),
    stop: () => ipcRenderer.invoke("vscode:stop")
  }
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);
