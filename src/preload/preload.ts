import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { TranscribeOptions } from "../lib/engine/types";
import {
  CH,
  type ProgressMsg,
  type SaveArgs,
  type SetupProgressMsg,
  type SetupStatus,
  type StartArgs,
  type UpdateStatus,
} from "../shared/ipc";

const api = {
  /** Resolve the absolute path of a dropped/picked File (Electron 32+). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Start a transcription job. Progress arrives via onProgress. */
  start: (videoPath: string, options: TranscribeOptions): Promise<{ jobId: string }> =>
    ipcRenderer.invoke(CH.start, { videoPath, options } satisfies StartArgs),

  cancel: (jobId: string): Promise<void> => ipcRenderer.invoke(CH.cancel, jobId),

  /** Show a save dialog and write `text`. Returns the path, or null if canceled. */
  save: (text: string, defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke(CH.save, { text, defaultName } satisfies SaveArgs),

  /** Subscribe to progress events. Returns an unsubscribe function. */
  onProgress: (cb: (msg: ProgressMsg) => void): (() => void) => {
    const listener = (_e: unknown, msg: ProgressMsg): void => cb(msg);
    ipcRenderer.on(CH.progress, listener);
    return () => ipcRenderer.removeListener(CH.progress, listener);
  },

  // ---- first-run model setup ----
  setupStatus: (): Promise<SetupStatus> => ipcRenderer.invoke(CH.setupStatus),
  setupDownload: (): Promise<SetupStatus> => ipcRenderer.invoke(CH.setupDownload),
  onSetupProgress: (cb: (msg: SetupProgressMsg) => void): (() => void) => {
    const listener = (_e: unknown, msg: SetupProgressMsg): void => cb(msg);
    ipcRenderer.on(CH.setupProgress, listener);
    return () => ipcRenderer.removeListener(CH.setupProgress, listener);
  },

  // ---- auto-update ----
  onUpdateStatus: (cb: (msg: UpdateStatus) => void): (() => void) => {
    const listener = (_e: unknown, msg: UpdateStatus): void => cb(msg);
    ipcRenderer.on(CH.updateStatus, listener);
    return () => ipcRenderer.removeListener(CH.updateStatus, listener);
  },
  restartToUpdate: (): Promise<void> => ipcRenderer.invoke(CH.updateInstall),
};

contextBridge.exposeInMainWorld("transcriber", api);

export type TranscriberApi = typeof api;
