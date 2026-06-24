import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

import type { Binaries } from "../lib/engine/types";

/**
 * Resolve a helper binary. In a packaged app, prefer the platform binary bundled
 * under resources/bin (placed there by electron-builder, Task #5). In dev, fall
 * back to PATH (Homebrew-installed whisper-cli / ffmpeg), overridable via env.
 */
function bin(name: string, env?: string): string {
  if (env && process.env[env]) return process.env[env]!;
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, "bin", exe);
    if (existsSync(bundled)) return bundled;
  }
  return name; // PATH
}

export function resolveAppBinaries(): Binaries {
  return {
    whisperCli: bin("whisper-cli", "WHISPER_CLI"),
    ffmpeg: bin("ffmpeg", "FFMPEG"),
    ffprobe: bin("ffprobe", "FFPROBE"),
  };
}
