import * as vscode from "vscode";
import WebSocket from "ws";

const endpointSetting = "mcpConnector.endpoint";
const sendDocumentTextSetting = "mcpConnector.sendDocumentText";
const tokenSecretKey = "mcpConnector.bearerToken";
const maxSelectedTextLength = 64 * 1024;
const maxDocumentTextLength = 256 * 1024;

let socket: WebSocket | undefined;
let statusBarItem: vscode.StatusBarItem;
let sendTimer: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "mcpConnector.configure";
  context.subscriptions.push(statusBarItem);
  updateStatus("Disconnected");

  context.subscriptions.push(
    vscode.commands.registerCommand("mcpConnector.connect", () => connect(context)),
    vscode.commands.registerCommand("mcpConnector.disconnect", () => disconnect()),
    vscode.commands.registerCommand("mcpConnector.configure", () => configure(context)),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleContextSend(context)),
    vscode.window.onDidChangeTextEditorSelection(() => scheduleContextSend(context)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(endpointSetting)) {
        disconnect();
      }
    })
  );
}

export function deactivate(): void {
  disconnect();
}

async function configure(context: vscode.ExtensionContext): Promise<void> {
  const endpoint = await vscode.window.showInputBox({
    prompt: "Paste the WebSocket endpoint from MCP Connector",
    value: getEndpoint(),
    ignoreFocusOut: true,
    validateInput: (value) => /^ws:\/\/127\.0\.0\.1:\d+$/.test(value) ? undefined : "Use ws://127.0.0.1:<port>."
  });
  if (endpoint === undefined) return;
  await vscode.workspace.getConfiguration().update(endpointSetting, endpoint, vscode.ConfigurationTarget.Global);

  const token = await vscode.window.showInputBox({
    prompt: "Paste the bearer token from MCP Connector",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim().length >= 32 ? undefined : "The bearer token is invalid."
  });
  if (token === undefined) return;
  await context.secrets.store(tokenSecretKey, token.trim());
  await connect(context);
}

async function connect(context: vscode.ExtensionContext): Promise<void> {
  disconnect();
  const endpoint = getEndpoint();
  const token = await context.secrets.get(tokenSecretKey);
  if (token === undefined) {
    void vscode.window.showErrorMessage("Configure the MCP Connector endpoint and bearer token first.");
    return;
  }

  const nextSocket = new WebSocket(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    handshakeTimeout: 5000
  });
  socket = nextSocket;
  nextSocket.once("open", () => {
    updateStatus("Connected");
    scheduleContextSend(context);
  });
  nextSocket.on("close", () => {
    if (socket === nextSocket) socket = undefined;
    updateStatus("Disconnected");
  });
  nextSocket.on("error", () => updateStatus("Connection error"));
}

function disconnect(): void {
  if (sendTimer !== undefined) {
    clearTimeout(sendTimer);
    sendTimer = undefined;
  }
  socket?.close();
  socket = undefined;
  updateStatus("Disconnected");
}

function scheduleContextSend(context: vscode.ExtensionContext): void {
  if (sendTimer !== undefined) clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    sendTimer = undefined;
    void sendActiveContext(context);
  }, 150);
}

async function sendActiveContext(context: vscode.ExtensionContext): Promise<void> {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const editor = vscode.window.activeTextEditor;
  const workspaceFolder = editor === undefined
    ? vscode.workspace.workspaceFolders?.[0]
    : vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (editor === undefined || workspaceFolder === undefined) return;

  const message: Record<string, string> = {
    type: "vscode.context",
    workspacePath: workspaceFolder.uri.fsPath,
    filePath: editor.document.uri.fsPath,
    languageId: editor.document.languageId,
    selectedText: editor.document.getText(editor.selection).slice(0, maxSelectedTextLength)
  };
  if (vscode.workspace.getConfiguration().get<boolean>(sendDocumentTextSetting, false)) {
    message.documentText = editor.document.getText().slice(0, maxDocumentTextLength);
  }
  socket.send(JSON.stringify(message));
}

function getEndpoint(): string {
  return vscode.workspace.getConfiguration().get<string>(endpointSetting, "").trim();
}

function updateStatus(label: string): void {
  if (statusBarItem === undefined) return;
  statusBarItem.text = `$(plug) MCP: ${label}`;
  statusBarItem.show();
}
