import { app } from "electron";
import { autoUpdater } from "electron-updater";

export type UpdaterPhase =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "unavailable"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdaterStatus {
  readonly enabled: boolean;
  readonly phase: UpdaterPhase;
  readonly currentVersion: string;
  readonly availableVersion: string | null;
  readonly downloadedVersion: string | null;
  readonly progressPercent: number | null;
  readonly lastCheckedAt: string | null;
  readonly message: string | null;
}

function toErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unknown updater error.";
}

export class AutoUpdateService {
  private status: UpdaterStatus = {
    enabled: false,
    phase: "disabled",
    currentVersion: app.getVersion(),
    availableVersion: null,
    downloadedVersion: null,
    progressPercent: null,
    lastCheckedAt: null,
    message: "Auto-update is disabled. Set MCP_UPDATER_ENABLED=true and MCP_UPDATE_FEED_URL to enable."
  };

  public constructor() {
    const enabled = process.env.MCP_UPDATER_ENABLED === "true";
    const feedUrl = process.env.MCP_UPDATE_FEED_URL;
    if (!enabled) {
      return;
    }
    if (feedUrl === undefined || feedUrl.trim().length === 0) {
      this.status = {
        ...this.status,
        phase: "error",
        message: "MCP_UPDATE_FEED_URL is required when MCP_UPDATER_ENABLED=true."
      };
      return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.setFeedURL({
      provider: "generic",
      url: feedUrl,
      ...(process.env.MCP_UPDATE_CHANNEL === undefined
        ? {}
        : { channel: process.env.MCP_UPDATE_CHANNEL }),
      ...(process.env.MCP_UPDATE_FEED_TOKEN === undefined
        ? {}
        : { requestHeaders: { Authorization: `Bearer ${process.env.MCP_UPDATE_FEED_TOKEN}` } })
    });

    this.status = {
      ...this.status,
      enabled: true,
      phase: "idle",
      message: null
    };

    autoUpdater.on("checking-for-update", () => {
      this.status = {
        ...this.status,
        phase: "checking",
        lastCheckedAt: new Date().toISOString(),
        message: null
      };
    });

    autoUpdater.on("update-available", (info) => {
      this.status = {
        ...this.status,
        phase: "available",
        availableVersion: info.version,
        message: info.releaseName ?? "Update is available."
      };
    });

    autoUpdater.on("update-not-available", () => {
      this.status = {
        ...this.status,
        phase: "unavailable",
        availableVersion: null,
        downloadedVersion: null,
        progressPercent: null,
        message: "You are running the latest version."
      };
    });

    autoUpdater.on("download-progress", (progress) => {
      this.status = {
        ...this.status,
        phase: "downloading",
        progressPercent: Math.max(0, Math.min(100, progress.percent)),
        message: `Downloading update (${progress.percent.toFixed(1)}%).`
      };
    });

    autoUpdater.on("update-downloaded", (info) => {
      this.status = {
        ...this.status,
        phase: "downloaded",
        downloadedVersion: info.version,
        progressPercent: 100,
        message: "Update downloaded and ready to install."
      };
    });

    autoUpdater.on("error", (cause) => {
      this.status = {
        ...this.status,
        phase: "error",
        message: toErrorMessage(cause)
      };
    });
  }

  public getStatus(): UpdaterStatus {
    return this.status;
  }

  public async checkForUpdates(): Promise<UpdaterStatus> {
    if (!this.status.enabled) {
      throw new Error(this.status.message ?? "Auto-update is disabled.");
    }

    try {
      await autoUpdater.checkForUpdates();
      return this.status;
    } catch (cause: unknown) {
      const message = `Unable to check for updates: ${toErrorMessage(cause)}`;
      this.status = { ...this.status, phase: "error", message };
      throw new Error(message);
    }
  }

  public async downloadUpdate(): Promise<UpdaterStatus> {
    if (!this.status.enabled) {
      throw new Error(this.status.message ?? "Auto-update is disabled.");
    }
    if (this.status.phase !== "available") {
      throw new Error("No available update to download.");
    }

    try {
      await autoUpdater.downloadUpdate();
      return this.status;
    } catch (cause: unknown) {
      const message = `Unable to download update: ${toErrorMessage(cause)}`;
      this.status = { ...this.status, phase: "error", message };
      throw new Error(message);
    }
  }

  public quitAndInstall(): void {
    if (!this.status.enabled) {
      throw new Error(this.status.message ?? "Auto-update is disabled.");
    }
    if (this.status.phase !== "downloaded") {
      throw new Error("No downloaded update is ready to install.");
    }
    autoUpdater.quitAndInstall(false, true);
  }
}
