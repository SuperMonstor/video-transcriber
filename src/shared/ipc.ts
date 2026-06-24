// IPC channel names + message shapes shared by main, preload, and renderer.
// Only type-level imports from the engine (pure types) — safe everywhere.
import type { Progress, TranscribeOptions } from "../lib/engine/types";

export const CH = {
  start: "transcribe:start",
  cancel: "transcribe:cancel",
  progress: "transcribe:progress",
  save: "transcribe:save",
} as const;

export type StartArgs = { videoPath: string; options: TranscribeOptions };
export type SaveArgs = { text: string; defaultName: string };

/** Progress event tagged with the job it belongs to. */
export type ProgressMsg = { jobId: string } & Progress;
