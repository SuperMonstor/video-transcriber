import { contextBridge } from "electron";

// The renderer-facing API is intentionally tiny. It grows in Task #3 when the
// engine is wired in (transcribe, onProgress, cancel, export). For the scaffold
// we just expose a version string so we can confirm the bridge works.
const api = {
  version: process.versions.electron,
};

contextBridge.exposeInMainWorld("transcriber", api);

export type TranscriberApi = typeof api;
