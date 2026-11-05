import { contextBridge, ipcRenderer } from "electron";
import type { WorkflowPreviewState } from "@mcp-connector/core";
import type { DesktopApi } from "./shared/desktop-api";
import type { ExternalServerItem } from "./connection/external-server-store";

const desktopApi: DesktopApi = {
  app: {
    getVersion: () => ipcRenderer.invoke("app:get-version") as Promise<string>,
    getStartupProblems: () => ipcRenderer.invoke("app:get-startup-problems") as Promise<readonly string[]>,
    openLogsFolder: () => ipcRenderer.invoke("app:open-logs-folder") as Promise<void>
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
  connectors: {
    list: () => ipcRenderer.invoke("connectors:list"),
    startSignIn: (id) => ipcRenderer.invoke("connectors:start-sign-in", id),
    openSignInPage: (id) => ipcRenderer.invoke("connectors:open-sign-in-page", id) as Promise<void>,
    finishSignIn: (id) => ipcRenderer.invoke("connectors:finish-sign-in", id) as Promise<void>,
    cancelSignIn: (id) => ipcRenderer.invoke("connectors:cancel-sign-in", id) as Promise<void>,
    disconnect: (id) => ipcRenderer.invoke("connectors:disconnect", id) as Promise<void>,
    setSetting: (id, key, value) => ipcRenderer.invoke("connectors:set-setting", id, key, value)
  },
  external: {
    list: () => ipcRenderer.invoke("external:list"),
    add: (setup, approval) => ipcRenderer.invoke("external:add", setup, approval),
    remove: (id) => ipcRenderer.invoke("external:remove", id),
    reconnect: (id) => ipcRenderer.invoke("external:reconnect", id),
    setApproval: (id, approval) => ipcRenderer.invoke("external:set-approval", id, approval),
    subscribe: (listener) => {
      const callback = (_event: Electron.IpcRendererEvent, servers: readonly ExternalServerItem[]) => listener(servers);
      ipcRenderer.on("external:changed", callback);
      return () => ipcRenderer.removeListener("external:changed", callback);
    }
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
