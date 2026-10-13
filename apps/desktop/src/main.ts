import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  FilesystemService,
  FetchOAuthTokenService,
  OfficialNotionConnector,
  OctokitGitHubConnector,
  OAuthPkceService,
  PrismaAuditRepository,
  startMcpHttpServer,
  WorkflowService
} from "@mcp-connector/core";
import { CredentialVault } from "./security/credential-vault";
import { OAuthCallbackServer } from "./security/oauth-callback-server";
import { VaultTokenProvider } from "./security/vault-token-provider";
import { applyDatabaseMigrations } from "./database/migrations";
import { startVsCodeContextServer, type VsCodeContextServerHandle } from "./security/vscode-context-server";
import type { McpHttpServerHandle } from "@mcp-connector/core";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

const isDevelopment = process.env.NODE_ENV === "development";
const filesystemService = new FilesystemService();
const oauthPkceService = new OAuthPkceService();
const oauthTokenService = new FetchOAuthTokenService();
let mcpHttpServer: McpHttpServerHandle | null = null;
let vsCodeContextServer: VsCodeContextServerHandle | null = null;

const developmentRendererOrigin = "http://localhost:5173";

function isAllowedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return !isDevelopment;
    return isDevelopment && url.origin === developmentRendererOrigin;
  } catch {
    return false;
  }
}

function configureElectronSecurity(): void {
  const contentSecurityPolicy = [
    "default-src 'self'",
    `script-src 'self'${isDevelopment ? ` ${developmentRendererOrigin}` : ""}`,
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self'${isDevelopment ? ` ${developmentRendererOrigin} ws://localhost:5173` : ""}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy]
      }
    });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function getOAuthConfig(provider: "github" | "notion") {
  const clientId = provider === "github"
    ? process.env.MCP_GITHUB_CLIENT_ID
    : process.env.MCP_NOTION_CLIENT_ID;
  const clientSecret = provider === "github"
    ? process.env.MCP_GITHUB_CLIENT_SECRET
    : process.env.MCP_NOTION_CLIENT_SECRET;
  if (clientId === undefined || clientId.trim().length === 0) {
    throw new Error(`${provider} OAuth client ID is not configured.`);
  }

  const config = provider === "github"
    ? {
        provider,
        authorizationEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        clientId,
        scopes: ["read:user", "repo"]
      }
    : {
        provider,
        authorizationEndpoint: "https://api.notion.com/v1/oauth/authorize",
        tokenEndpoint: "https://api.notion.com/v1/oauth/token",
        clientId,
        scopes: []
      };
  return clientSecret === undefined ? config : { ...config, clientSecret };
}

function registerIpcHandlers(
  workflowService: WorkflowService,
  auditRepository: PrismaAuditRepository,
  credentialVault: CredentialVault,
  oauthCallbackServer: OAuthCallbackServer,
  getNotionConnector: () => OfficialNotionConnector,
  getGithubConnector: () => OctokitGitHubConnector
): void {
  ipcMain.handle("app:get-version", () => app.getVersion());

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
    }
    return workspacePath;
  });

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

  ipcMain.handle("workflow:execute-approved", async (_event, previewId: unknown) => {
    if (typeof previewId !== "string") {
      throw new Error("Preview ID must be a string.");
    }

    return workflowService.executeApproved(previewId, async (preview) => {
      if (preview.action !== "CREATE" || preview.target !== "Notion project page") {
        throw new Error("No executor is registered for this workflow target.");
      }

      const readme = typeof preview.payload.readme === "string"
        ? preview.payload.readme
        : "No README was found for this workspace.";
      return getNotionConnector().createPage({
        title: typeof preview.payload.workspacePath === "string"
          ? preview.payload.workspacePath.split(/[\\/]/u).pop() ?? "Project"
          : "Project",
        markdown: readme
      });
    });
  });

  ipcMain.handle("credentials:get-status", async () => ({
    github: await credentialVault.has("github"),
    notion: await credentialVault.has("notion")
  }));

  ipcMain.handle("credentials:connect", async (_event, provider: unknown) => {
    if (provider !== "github" && provider !== "notion") {
      throw new Error("Unsupported OAuth provider.");
    }

    const redirectUri = await oauthCallbackServer.start();
    try {
      const authorization = oauthPkceService.beginAuthorization(
        getOAuthConfig(provider),
        redirectUri
      );
      await shell.openExternal(authorization.authorizationUrl);
      const callback = await oauthCallbackServer.waitForCallback();
      const codeVerifier = oauthPkceService.consumeAuthorization(callback.state, provider);
      const tokenSet = await oauthTokenService.exchangeCode(
        getOAuthConfig(provider),
        callback.code,
        codeVerifier,
        redirectUri
      );
      await credentialVault.save({
        provider,
        accessToken: tokenSet.accessToken,
        refreshToken: tokenSet.refreshToken,
        expiresAt: tokenSet.expiresAt,
        tokenType: tokenSet.tokenType,
        scope: tokenSet.scope
      });
    } finally {
      await oauthCallbackServer.close();
    }
  });

  ipcMain.handle("credentials:disconnect", async (_event, provider: unknown) => {
    if (provider !== "github" && provider !== "notion") {
      throw new Error("Unsupported OAuth provider.");
    }
    await credentialVault.remove(provider);
  });

  ipcMain.handle("mcp:get-status", () => ({
    enabled: mcpHttpServer !== null,
    url: mcpHttpServer?.url ?? null,
    bearerToken: mcpHttpServer?.bearerToken ?? null
  }));

  ipcMain.handle("mcp:start", async () => {
    if (mcpHttpServer !== null) {
      return { url: mcpHttpServer.url, bearerToken: mcpHttpServer.bearerToken };
    }
    mcpHttpServer = await startMcpHttpServer({
      filesystem: filesystemService,
      workflow: workflowService,
      notion: getNotionConnector(),
      github: getGithubConnector()
    });
    return { url: mcpHttpServer.url, bearerToken: mcpHttpServer.bearerToken };
  });

  ipcMain.handle("mcp:stop", async () => {
    if (mcpHttpServer === null) return;
    const server = mcpHttpServer;
    mcpHttpServer = null;
    await server.close();
  });

  ipcMain.handle("vscode:get-status", () => ({
    enabled: vsCodeContextServer !== null,
    url: vsCodeContextServer?.url ?? null,
    bearerToken: vsCodeContextServer?.bearerToken ?? null,
    latestContext: vsCodeContextServer?.latestContext ?? null
  }));

  ipcMain.handle("vscode:start", async () => {
    if (vsCodeContextServer !== null) {
      return { url: vsCodeContextServer.url, bearerToken: vsCodeContextServer.bearerToken };
    }
    vsCodeContextServer = await startVsCodeContextServer((context) => {
      console.log(`Accepted VS Code context for workspace: ${context.workspacePath}`);
    });
    return { url: vsCodeContextServer.url, bearerToken: vsCodeContextServer.bearerToken };
  });

  ipcMain.handle("vscode:stop", async () => {
    if (vsCodeContextServer === null) return;
    const server = vsCodeContextServer;
    vsCodeContextServer = null;
    await server.close();
  });
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: join(currentDirectory, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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

app.whenReady().then(async () => {
  configureElectronSecurity();
  process.env.DATABASE_URL = `file:${join(app.getPath("userData"), "mcp-connector.db")}`;
  const prisma = new PrismaClient();
  try {
    await applyDatabaseMigrations(prisma);
    const auditRepository = new PrismaAuditRepository(prisma);
    const workflowService = new WorkflowService(auditRepository, auditRepository);
    const credentialVault = new CredentialVault();
    const oauthCallbackServer = new OAuthCallbackServer();
    registerIpcHandlers(
      workflowService,
      auditRepository,
      credentialVault,
      oauthCallbackServer,
      () => {
        const notionDatabaseId = process.env.MCP_NOTION_DATABASE_ID;
        if (notionDatabaseId === undefined || notionDatabaseId.trim().length === 0) {
          throw new Error("MCP_NOTION_DATABASE_ID is not configured.");
        }
        return new OfficialNotionConnector(
          new VaultTokenProvider(
            credentialVault,
            "notion",
            () => getOAuthConfig("notion"),
            (config, refreshToken) => oauthTokenService.refreshAccessToken(config, refreshToken)
          ),
          { databaseId: notionDatabaseId }
        );
      },
      () => new OctokitGitHubConnector(new VaultTokenProvider(
        credentialVault,
        "github",
        () => getOAuthConfig("github"),
        (config, refreshToken) => oauthTokenService.refreshAccessToken(config, refreshToken)
      ))
    );
    if (process.env.MCP_HTTP_ENABLED === "true") {
      const dependencies = {
        filesystem: filesystemService,
        workflow: workflowService,
        github: new OctokitGitHubConnector(new VaultTokenProvider(
          credentialVault,
          "github",
          () => getOAuthConfig("github"),
          (config, refreshToken) => oauthTokenService.refreshAccessToken(config, refreshToken)
        ))
      };
      const databaseId = process.env.MCP_NOTION_DATABASE_ID;
      if (databaseId !== undefined && databaseId.trim().length > 0) {
        mcpHttpServer = await startMcpHttpServer({
          ...dependencies,
          notion: new OfficialNotionConnector(
            new VaultTokenProvider(
              credentialVault,
              "notion",
              () => getOAuthConfig("notion"),
              (config, refreshToken) => oauthTokenService.refreshAccessToken(config, refreshToken)
            ),
            { databaseId }
          )
        });
      } else {
        mcpHttpServer = await startMcpHttpServer(dependencies);
      }
      console.log(`MCP HTTP server listening at ${mcpHttpServer.url}`);
    }
    createMainWindow();
  } catch (error) {
    console.error("Unable to initialize MCP Connector database.", error);
    await prisma.$disconnect();
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (mcpHttpServer !== null) {
    void mcpHttpServer.close();
    mcpHttpServer = null;
  }
  if (vsCodeContextServer !== null) {
    void vsCodeContextServer.close();
    vsCodeContextServer = null;
  }
});
