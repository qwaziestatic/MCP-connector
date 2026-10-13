import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "./shared/desktop-api";

const desktopApi: DesktopApi = {
  app: {
    getVersion: () => ipcRenderer.invoke("app:get-version") as Promise<string>
  },
  filesystem: {
    chooseWorkspace: () =>
      ipcRenderer.invoke("filesystem:choose-workspace") as Promise<string | null>,
    inspectWorkspace: (workspacePath) =>
      ipcRenderer.invoke("filesystem:inspect-workspace", workspacePath)
  },
  workflow: {
    createPreview: (action, target, summary, payload) =>
      ipcRenderer.invoke("workflow:create-preview", action, target, summary, payload),
    approve: (previewId) => ipcRenderer.invoke("workflow:approve", previewId),
    reject: (previewId) => ipcRenderer.invoke("workflow:reject", previewId),
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
    stop: () => ipcRenderer.invoke("mcp:stop")
  },
  vscode: {
    getStatus: () => ipcRenderer.invoke("vscode:get-status"),
    start: () => ipcRenderer.invoke("vscode:start"),
    stop: () => ipcRenderer.invoke("vscode:stop")
  }
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);
