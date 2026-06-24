import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app } from "electron";

import type { ModelName } from "../lib/engine/types";

type Asset = { file: string; url: string; bytes: number; required: boolean };

// whisper.cpp GGML models + Silero VAD, hosted on Hugging Face.
const ASSETS = {
  "large-v3-turbo": {
    file: "ggml-large-v3-turbo.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
    bytes: 1_624_555_275,
    required: true,
  },
  "silero-vad": {
    file: "ggml-silero-v5.1.2.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
    bytes: 0,
    required: false, // best-effort; VAD just stays off if it can't be fetched
  },
} satisfies Record<string, Asset>;

export type AssetId = keyof typeof ASSETS;

const MODEL_ASSET: Record<ModelName, AssetId> = {
  "large-v3-turbo": "large-v3-turbo",
  medium: "large-v3-turbo", // medium not bundled in M1; falls back to turbo
};

/** Where downloaded models live. Dev can point at an existing dir via env. */
export function modelsDir(): string {
  return process.env.WHISPER_MODEL_DIR || join(app.getPath("userData"), "models");
}

function assetPath(id: AssetId): string {
  return join(modelsDir(), ASSETS[id].file);
}

export function modelPathFor(model: ModelName): string {
  return assetPath(MODEL_ASSET[model]);
}

export function vadModelPath(): string | null {
  const p = assetPath("silero-vad");
  return existsSync(p) ? p : null;
}

/** First-run gate: are the required assets present? */
export function isReady(): boolean {
  return existsSync(assetPath("large-v3-turbo"));
}

export type DownloadProgress = (received: number, total: number) => void;

/** Download an asset to the models dir (atomic via .part rename). Skips if present. */
export async function download(id: AssetId, onProgress: DownloadProgress): Promise<void> {
  const asset = ASSETS[id];
  await mkdir(modelsDir(), { recursive: true });
  const dest = assetPath(id);
  if (existsSync(dest)) return;

  const res = await fetch(asset.url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${asset.file}: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get("content-length")) || asset.bytes || 0;

  let received = 0;
  let lastPct = -1;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (total) {
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress(received, total);
        }
      }
      cb(null, chunk);
    },
  });

  const tmp = `${dest}.part`;
  // res.body is a DOM ReadableStream; Node's fromWeb wants its own web type.
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(source, counter, createWriteStream(tmp));
  await rename(tmp, dest);
}

/** Ensure required assets exist, downloading what's missing. VAD is best-effort. */
export async function ensureAssets(onProgress: (id: AssetId, received: number, total: number) => void): Promise<void> {
  await download("large-v3-turbo", (r, t) => onProgress("large-v3-turbo", r, t));
  try {
    await download("silero-vad", (r, t) => onProgress("silero-vad", r, t));
  } catch {
    // VAD unavailable — transcription still works, just without silence-skipping.
  }
}
