import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import {
  createBuiltInConnectors,
  createNotionPagePreview,
  executeApprovedPreview,
  FilesystemService,
  PrismaAuditRepository,
  WorkflowService
} from "@mcp-connector/core";
import { CredentialVault } from "./security/credential-vault";
import { ConnectorHub } from "./connection/connector-hub";
import { ConnectorSettings } from "./connection/connector-settings";
import { createSignInFlow, createTokenRefresh } from "./connection/sign-in-kinds";
import { applyDatabaseMigrations } from "./database/migrations";
import { AgentConnectionManager } from "./connection/connection-manager";
import { buildAgentConfigs } from "./connection/agent-config";
import { AutoUpdateService } from "./updater/auto-update.service";
import { buildContentSecurityPolicy, developmentRendererOrigin } from "./security/content-security-policy";
import { AppSettingsStore } from "./settings/app-settings";
import { isStdioMode, runStdioMode, STDIO_FLAG, useRelayProfile } from "./stdio/stdio-mode";
import { createFileLogger } from "./logging/file-logger";
import { describeStartupError } from "./logging/startup-error";
import { createApprovalNotifier } from "./notifications/approval-notifier";
import type { McpConnectorDependencies, WorkflowPreview } from "@mcp-connector/core";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

const isDevelopment = process.env.NODE_ENV === "development";
const filesystemService = new FilesystemService();
let connections: AgentConnectionManager | null = null;
let autoUpdateService: AutoUpdateService | null = null;
// Problems found while starting, such as a busy port, shown once in the window.
let startupProblems: readonly string[] = [];

function isAllowedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      return !isDevelopment && fileURLToPath(url) === join(currentDirectory, "../renderer/index.html");
    }
    return isDevelopment && url.origin === developmentRendererOrigin;
  } catch {
    return false;
  }
}

function configureElectronSecurity(): void {
  const contentSecurityPolicy = buildContentSecurityPolicy(isDevelopment ? "development" : "production");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy]
      }
    });
  });
  // Everything is denied except writing text to the clipboard, which the Copy
  // buttons need. Reading the clipboard stays denied.
  const isAllowedPermission = (permission: string): boolean => permission === "clipboard-sanitized-write";
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isAllowedPermission(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => isAllowedPermission(permission));
}

function registerIpcHandlers(
  workflowService: WorkflowService,
  auditRepository: PrismaAuditRepository,
  connectorHub: ConnectorHub,
  connectionManager: AgentConnectionManager,
  settings: AppSettingsStore
): void {
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("app:get-startup-problems", () => startupProblems);
  ipcMain.handle("app:open-logs-folder", async () => {
    const failure = await shell.openPath(app.getPath("logs"));
    if (failure.length > 0) throw new Error(`Could not open the logs folder: ${failure}`);
  });
  ipcMain.handle("updater:get-status", () => autoUpdateService?.getStatus() ?? {
    enabled: false,
    phase: "disabled",
    currentVersion: app.getVersion(),
    availableVersion: null,
    downloadedVersion: null,
    progressPercent: null,
    lastCheckedAt: null,
    message: "Auto-update service is not initialized."
  });
  ipcMain.handle("updater:check", async () => {
    if (autoUpdateService === null) {
      throw new Error("Auto-update service is not initialized.");
    }
    return autoUpdateService.checkForUpdates();
  });
  ipcMain.handle("updater:download", async () => {
    if (autoUpdateService === null) {
      throw new Error("Auto-update service is not initialized.");
    }
    return autoUpdateService.downloadUpdate();
  });
  ipcMain.handle("updater:quit-and-install", () => {
    if (autoUpdateService === null) {
      throw new Error("Auto-update service is not initialized.");
    }
    autoUpdateService.quitAndInstall();
  });

  ipcMain.handle("filesystem:choose-workspace", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Choose a workspace directory"
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const workspacePath = result.filePaths[0] ?? null;
    if (workspacePath !== null) {
      filesystemService.setAllowedWorkspaceRoot(workspacePath);
      await settings.update({ workspacePath });
    }
    return workspacePath;
  });

  ipcMain.handle("filesystem:get-selected-workspace", () =>
    filesystemService.getAllowedWorkspaceRoot() ?? null);

  ipcMain.handle("filesystem:inspect-workspace", async (_event, workspacePath: unknown) => {
    if (typeof workspacePath !== "string") {
      throw new Error("Workspace path must be a string.");
    }
    if (filesystemService.getAllowedWorkspaceRoot() === undefined) {
      throw new Error("Choose a workspace before inspecting files.");
    }
    return filesystemService.inspectWorkspace(workspacePath);
  });

  ipcMain.handle(
    "workflow:create-preview",
    async (_event, action: unknown, target: unknown, summary: unknown, payload: unknown) => {
      if (
        typeof action !== "string" ||
        typeof target !== "string" ||
        typeof summary !== "string" ||
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new Error("Invalid workflow preview request.");
      }
      return workflowService.createPreview(action, target, summary, payload);
    }
  );

  ipcMain.handle("workflow:approve", async (_event, previewId: unknown) => {
    if (typeof previewId !== "string") {
      throw new Error("Preview ID must be a string.");
    }
    return workflowService.approve(previewId);
  });

  ipcMain.handle("workflow:reject", async (_event, previewId: unknown) => {
    if (typeof previewId !== "string") {
      throw new Error("Preview ID must be a string.");
    }
    return workflowService.reject(previewId);
  });

  ipcMain.handle("workflow:list-audit-records", () => auditRepository.list());
  ipcMain.handle("workflow:list-pending", () => workflowService.listPending());
  workflowService.subscribe((previews) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("workflow:changed", previews);
    }
  });

  ipcMain.handle("workflow:execute-approved", async (_event, previewId: unknown) => {
    if (typeof previewId !== "string") {
      throw new Error("Preview ID must be a string.");
    }

    // The same path as the agents' tools: the connector that made the preview
    // checks its sign-in and settings first, so a missing one does not use up
    // the approval, then sends exactly what was approved.
    return executeApprovedPreview(workflowService, connectorHub.connectors, previewId);
  });

  ipcMain.handle("notion:create-page-preview", async (_event, title: unknown, markdown: unknown) => {
    if (typeof title !== "string" || typeof markdown !== "string") {
      throw new Error("Invalid Notion page preview request.");
    }
    return createNotionPagePreview(workflowService, { title, markdown }, "ui");
  });

  // Every connector signs in, out, and is set up through the same requests;
  // the hub checks the connector id the window sends.
  ipcMain.handle("connectors:list", () => connectorHub.list());
  ipcMain.handle("connectors:start-sign-in", (_event, id: unknown) => connectorHub.startSignIn(id));
  ipcMain.handle("connectors:open-sign-in-page", (_event, id: unknown) => connectorHub.openSignInPage(id));
  ipcMain.handle("connectors:finish-sign-in", (_event, id: unknown) => connectorHub.finishSignIn(id));
  ipcMain.handle("connectors:cancel-sign-in", (_event, id: unknown) => connectorHub.cancelSignIn(id));
  ipcMain.handle("connectors:disconnect", (_event, id: unknown) => connectorHub.disconnect(id));
  ipcMain.handle("connectors:set-setting", (_event, id: unknown, key: unknown, value: unknown) =>
    connectorHub.setSetting(id, key, value));

  ipcMain.handle("mcp:get-status", () => connectionManager.getMcpStatus());
  ipcMain.handle("mcp:start", () => connectionManager.startMcp());
  ipcMain.handle("mcp:stop", () => connectionManager.stopMcp());
  ipcMain.handle("mcp:regenerate-token", () => connectionManager.regenerateMcpToken());
  ipcMain.handle("mcp:get-agent-configs", async () => {
    const status = await connectionManager.getMcpStatus();
    if (status.url === null) {
      throw new Error("Start the MCP server first: its port is chosen when it starts.");
    }
    // The stdio command must point at the installed app, so it is only
    // offered in a packaged build, not in `npm run dev`.
    return buildAgentConfigs({
      url: status.url,
      bearerToken: status.bearerToken,
      ...(app.isPackaged ? { stdio: { command: process.execPath, args: [STDIO_FLAG] } } : {}),
      platform: process.platform
    });
  });

  ipcMain.handle("vscode:get-status", () => connectionManager.getVsCodeStatus());
  ipcMain.handle("vscode:start", () => connectionManager.startVsCode());
  ipcMain.handle("vscode:stop", () => connectionManager.stopVsCode());
}

// Notifications are kept referenced until closed; otherwise they can be
// garbage-collected and their click handler lost.
const shownNotifications = new Set<Notification>();

function showMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0] ?? createMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Tells the user that an AI agent is waiting for their approval. */
function announceApprovalRequest(preview: WorkflowPreview): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (window !== undefined && !window.isFocused()) {
    window.flashFrame(true);
  }
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: "An AI agent is asking for approval",
    body: `${preview.summary}. Open MCP Connector to approve or reject it.`
  });
  shownNotifications.add(notification);
  notification.on("click", () => {
    shownNotifications.delete(notification);
    showMainWindow();
  });
  notification.on("close", () => shownNotifications.delete(notification));
  notification.show();
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: join(currentDirectory, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.on("focus", () => window.flashFrame(false));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedRendererUrl(url)) {
      event.preventDefault();
    }
  });

  if (isDevelopment) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173");
  } else {
    void window.loadFile(join(currentDirectory, "../renderer/index.html"));
  }

  return window;
}

async function startDesktopApp(): Promise<void> {
  const log = createFileLogger(app.getPath("logs"));
  if (process.platform === "win32") {
    // Windows shows notifications only for an app ID that matches the installer's.
    app.setAppUserModelId("com.mcpconnector.desktop");
  }
  log.info(`Starting MCP Connector ${app.getVersion()} on ${process.platform}.`);
  process.on("uncaughtExceptionMonitor", (error) => log.error("Uncaught exception.", error));
  configureElectronSecurity();
  const databaseUrl = `file:${join(app.getPath("userData"), "mcp-connector.db")}`;
  process.env.DATABASE_URL = databaseUrl;
  let prisma: PrismaClient | null = null;
  autoUpdateService = new AutoUpdateService();
  try {
    // Loaded here rather than at the top of the file, so a missing or broken
    // database driver shows the startup error dialog below instead of
    // Electron's generic "JavaScript error in the main process".
    const { PrismaClient } = await import("@prisma/client");
    const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
    prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databaseUrl }) });
    await applyDatabaseMigrations(prisma);
    log.info("Database ready.");
    const auditRepository = new PrismaAuditRepository(prisma);
    const workflowService = new WorkflowService(auditRepository, auditRepository);
    const credentialVault = new CredentialVault();
    const settings = new AppSettingsStore(join(app.getPath("userData"), "settings.json"));
    // Restore the workspace chosen in an earlier session, so MCP tools work
    // after a restart without the user choosing it again.
    const savedWorkspace = await settings.readExistingWorkspace();
    if (savedWorkspace !== undefined) {
      filesystemService.setAllowedWorkspaceRoot(savedWorkspace);
    }
    // Every service the app offers. Its tools are always listed for agents;
    // they explain what to do when a service is not connected or set up.
    const connectorHub = new ConnectorHub({
      definitions: createBuiltInConnectors(),
      vault: credentialVault,
      settings: await ConnectorSettings.load(settings),
      createSignIn: (definition) => createSignInFlow(definition, credentialVault, (url) => shell.openExternal(url)),
      createRefresh: createTokenRefresh
    });
    const getMcpDependencies = (): McpConnectorDependencies => ({
      filesystem: filesystemService,
      workflow: workflowService,
      connectors: connectorHub.connectors
    });
    const connectionManager = new AgentConnectionManager({
      settings,
      secrets: credentialVault,
      getMcpDependencies,
      endpointFilePath: join(app.getPath("userData"), "mcp-endpoint.json"),
      onVsCodeContext: (context) => {
        console.log(`Accepted VS Code context for workspace: ${context.workspacePath}`);
      },
      log: (message) => {
        console.log(message);
        log.info(message);
      }
    });
    connections = connectionManager;
    registerIpcHandlers(
      workflowService,
      auditRepository,
      connectorHub,
      connectionManager,
      settings
    );
    // Start what was running when the app last closed. MCP_HTTP_ENABLED=true
    // still forces the MCP server on, for scripted setups.
    startupProblems = await connectionManager.restoreOnLaunch({
      mcp: process.env.MCP_HTTP_ENABLED === "true"
    });
    for (const problem of startupProblems) {
      console.error(problem);
      log.error(problem);
    }
    if (autoUpdateService.getStatus().enabled) {
      try {
        await autoUpdateService.checkForUpdates();
      } catch (cause: unknown) {
        console.error("Auto-update check failed.", cause);
      }
    }
    createMainWindow();
    workflowService.subscribe(createApprovalNotifier(await workflowService.listPending(), (preview) => {
      log.info(`An agent asked for approval: ${preview.summary}`);
      announceApprovalRequest(preview);
    }));
  } catch (error) {
    // The packaged app has no visible console, so say what happened before quitting.
    console.error("MCP Connector could not start.", error);
    log.error("Startup failed.", error);
    const { title, message } = describeStartupError(error, app.getPath("userData"));
    dialog.showErrorBox(title, `${message}\n\nDetails were saved to:\n${log.path}`);
    await prisma?.$disconnect().catch(() => undefined);
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

if (isStdioMode()) {
  // No window and no database: only relay an agent's stdio to the running app.
  // Keep this path free of any single-instance lock, which would refuse to
  // start while the app is open.
  const relayProfile = useRelayProfile();
  app.disableHardwareAcceleration();
  app.dock?.hide();
  void app.whenReady()
    .then(() => runStdioMode(relayProfile))
    .catch((error: unknown) => {
      process.stderr.write(`MCP Connector stdio mode failed: ${error instanceof Error ? error.message : String(error)}\n`);
      app.exit(1);
    });
} else if (!app.requestSingleInstanceLock()) {
  // Another copy already has this data folder open. Two copies would share
  // the database and listeners, and the one that quits first would remove
  // the running server's address. The other copy shows its window instead.
  app.quit();
} else {
  app.on("second-instance", () => {
    if (app.isReady()) showMainWindow();
  });

  void app.whenReady().then(startDesktopApp);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    // Closing does not forget that the servers were running; they restart on the next launch.
    void connections?.closeAll();
    connections = null;
  });
}
