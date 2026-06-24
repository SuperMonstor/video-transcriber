import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { BrowserWindow, dialog, ipcMain } from "electron";

import { transcribe } from "../lib/engine/transcribe";
import type { Progress } from "../lib/engine/types";
import {
  CH,
  type SaveArgs,
  type SetupStatus,
  type StartArgs,
} from "../shared/ipc";
import { resolveAppBinaries } from "./binaries";
import {
  type AssetId,
  ensureAssets,
  isReady,
  modelPathFor,
  vadModelPath,
} from "./model-manager";

// Active jobs, so cancel can abort the right one.
const jobs = new Map<string, AbortController>();

export function registerIpc(): void {
  ipcMain.handle(CH.start, (event, args: StartArgs) => {
    const jobId = randomUUID();
    const ac = new AbortController();
    jobs.set(jobId, ac);

    const sender = event.sender;
    const send = (p: Progress) => {
      if (!sender.isDestroyed()) sender.send(CH.progress, { jobId, ...p });
    };

    // Inject resolved binaries + model/VAD paths the renderer can't know.
    const model = args.options.model ?? "large-v3-turbo";
    const options = {
      ...args.options,
      binaries: resolveAppBinaries(),
      modelPath: modelPathFor(model),
      vadModelPath: vadModelPath(),
    };

    // Fire and forget — the UI is driven by the progress stream (incl. done/error).
    void transcribe(args.videoPath, options, send, ac.signal)
      .catch(() => {
        /* error already delivered via the `error` progress event */
      })
      .finally(() => jobs.delete(jobId));

    return { jobId };
  });

  ipcMain.handle(CH.cancel, (_event, jobId: string) => {
    jobs.get(jobId)?.abort();
    jobs.delete(jobId);
  });

  ipcMain.handle(CH.save, async (event, args: SaveArgs) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      defaultPath: args.defaultName,
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, args.text, "utf8");
    return filePath;
  });

  ipcMain.handle(CH.setupStatus, (): SetupStatus => ({ ready: isReady() }));

  ipcMain.handle(CH.setupDownload, async (event): Promise<SetupStatus> => {
    const sender = event.sender;
    const emit = (id: AssetId, received: number, total: number) => {
      if (!sender.isDestroyed()) {
        sender.send(CH.setupProgress, { id, received, total, phase: "downloading" });
      }
    };
    try {
      await ensureAssets(emit);
      if (!sender.isDestroyed()) {
        sender.send(CH.setupProgress, { id: "large-v3-turbo", received: 1, total: 1, phase: "done" });
      }
      return { ready: isReady() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!sender.isDestroyed()) {
        sender.send(CH.setupProgress, { id: "large-v3-turbo", received: 0, total: 0, phase: "error", message });
      }
      return { ready: false };
    }
  });
}
