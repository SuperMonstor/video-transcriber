// IPC channel names + message shapes shared by main, preload, and renderer.
// Only type-level imports from the engine (pure types) — safe everywhere.
import type { Progress, TranscribeOptions } from "../lib/engine/types";

export const CH = {
  start: "transcribe:start",
  cancel: "transcribe:cancel",
  progress: "transcribe:progress",
  save: "transcribe:save",
  setupStatus: "setup:status",
  setupDownload: "setup:download",
  setupProgress: "setup:progress",
  updateStatus: "update:status",
  updateInstall: "update:install",
} as const;

export type StartArgs = { videoPath: string; options: TranscribeOptions };
export type SaveArgs = { text: string; defaultName: string };

/** Progress event tagged with the job it belongs to. */
export type ProgressMsg = { jobId: string } & Progress;

/** Whether required model assets are present (first-run gate). */
export type SetupStatus = { ready: boolean };

export type SetupProgressMsg = {
  id: string; // asset id, e.g. "large-v3-turbo"
  received: number;
  total: number;
  phase: "downloading" | "done" | "error";
  message?: string;
};

/** Auto-update lifecycle, pushed from main to renderer. */
export type UpdateStatus =
  | { state: "checking" }
  | { state: "none" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };
