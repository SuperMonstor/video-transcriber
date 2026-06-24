import type { BrowserWindow } from "electron";
import { app, ipcMain } from "electron";
import electronUpdater from "electron-updater";

import { CH, type UpdateStatus } from "../shared/ipc";

const { autoUpdater } = electronUpdater;

/**
 * Wire up auto-update. Checks GitHub Releases on launch, downloads in the
 * background, and lets the renderer trigger install-on-restart. No-ops in dev
 * (there's no update feed without a packaged build).
 */
export function setupUpdater(win: BrowserWindow): void {
  ipcMain.handle(CH.updateInstall, () => autoUpdater.quitAndInstall());

  if (!app.isPackaged) return;

  const send = (status: UpdateStatus) => {
    if (!win.isDestroyed()) win.webContents.send(CH.updateStatus, status);
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => send({ state: "checking" }));
  autoUpdater.on("update-available", (info) => send({ state: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => send({ state: "none" }));
  autoUpdater.on("download-progress", (p) =>
    send({ state: "downloading", percent: Math.floor(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    send({ state: "downloaded", version: info.version }),
  );
  autoUpdater.on("error", (err) =>
    send({ state: "error", message: err instanceof Error ? err.message : String(err) }),
  );

  autoUpdater.checkForUpdates().catch(() => {
    /* offline / no release yet — ignore */
  });
}
