import { join } from "node:path";
import type { Binaries, ModelName } from "./types";

const MODEL_FILES: Record<ModelName, string> = {
  "large-v3-turbo": "ggml-large-v3-turbo.bin",
  medium: "ggml-medium.bin",
};

/**
 * Default resolution from environment, used by dev + the smoke script. The
 * packaged app bypasses this by passing explicit paths in TranscribeOptions
 * (bundled binaries + downloaded model). See Task #4.
 */
export function resolveBinaries(): Binaries {
  return {
    whisperCli: process.env.WHISPER_CLI || "whisper-cli",
    ffmpeg: process.env.FFMPEG || "ffmpeg",
    ffprobe: process.env.FFPROBE || "ffprobe",
  };
}

export function resolveModelPath(model: ModelName): string {
  const dir = process.env.WHISPER_MODEL_DIR;
  if (!dir) {
    throw new Error(
      "Model directory unknown: set WHISPER_MODEL_DIR or pass options.modelPath",
    );
  }
  return join(dir, MODEL_FILES[model]);
}

export function resolveVadModel(): string | null {
  return process.env.WHISPER_VAD_MODEL || null;
}
