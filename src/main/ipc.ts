import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { BrowserWindow, dialog, ipcMain } from "electron";

import { transcribe } from "../lib/engine/transcribe";
import type { Progress } from "../lib/engine/types";
import { CH, type SaveArgs, type StartArgs } from "../shared/ipc";

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

    // Fire and forget — the UI is driven entirely by the progress stream
    // (including the terminal `done` / `error` events).
    void transcribe(args.videoPath, args.options, send, ac.signal)
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
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      defaultPath: args.defaultName,
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, args.text, "utf8");
    return filePath;
  });
}
