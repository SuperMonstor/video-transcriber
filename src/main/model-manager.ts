import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { app } from "electron";

import type { ModelName } from "../lib/engine/types";

const execFileAsync = promisify(execFile);

/**
 * The tar to extract archives with. On Windows, use the OS-bundled bsdtar by
 * absolute path: a bare `tar` can resolve to GNU tar (Git Bash / MSYS on PATH),
 * which parses `C:\...` as a remote `host:path` and fails with
 * "Cannot connect to C: resolve failed".
 */
function tarCommand(): string {
  if (process.platform !== "win32") return "tar";
  const systemTar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return existsSync(systemTar) ? systemTar : "tar";
}

type Asset = {
  file: string;
  url: string;
  bytes: number;
  required: boolean;
  archive?: "tar.bz2";
};

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
  "sherpa-segmentation": {
    file: "sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    bytes: 6_958_791,
    required: false,
    archive: "tar.bz2",
  },
  "sherpa-embedding": {
    file: "nemo_en_titanet_small.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx",
    bytes: 40_282_678,
    required: false,
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

export function diarizationSegmentationModelPath(): string | null {
  const p =
    process.env.SHERPA_ONNX_SEGMENTATION_MODEL ||
    assetPath("sherpa-segmentation");
  return existsSync(p) ? p : null;
}

export function diarizationEmbeddingModelPath(): string | null {
  const p =
    process.env.SHERPA_ONNX_EMBEDDING_MODEL ||
    assetPath("sherpa-embedding");
  return existsSync(p) ? p : null;
}

/** First-run gate: are the required assets present? */
export function isReady(): boolean {
  return existsSync(assetPath("large-v3-turbo"));
}

export type DownloadProgress = (received: number, total: number) => void;

/** Download an asset to the models dir (atomic via .part rename). Skips if present. */
export async function download(id: AssetId, onProgress: DownloadProgress): Promise<void> {
  const asset: Asset = ASSETS[id];
  await mkdir(modelsDir(), { recursive: true });
  const dest = assetPath(id);
  if (existsSync(dest)) return;
  await mkdir(dirname(dest), { recursive: true });

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

  const tmp = asset.archive ? join(modelsDir(), `${id}.part`) : `${dest}.part`;
  // res.body is a DOM ReadableStream; Node's fromWeb wants its own web type.
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(source, counter, createWriteStream(tmp));
  if (asset.archive === "tar.bz2") {
    try {
      await execFileAsync(tarCommand(), ["-xf", tmp, "-C", modelsDir()]);
    } finally {
      await rm(tmp, { force: true });
    }
  } else {
    await rename(tmp, dest);
  }
  if (!existsSync(dest)) {
    throw new Error(`Downloaded ${id}, but expected file was not found: ${dest}`);
  }
}

/** Ensure required assets exist, downloading what's missing. VAD is best-effort. */
export async function ensureAssets(onProgress: (id: AssetId, received: number, total: number) => void): Promise<void> {
  await download("large-v3-turbo", (r, t) => onProgress("large-v3-turbo", r, t));
  try {
    await download("silero-vad", (r, t) => onProgress("silero-vad", r, t));
  } catch {
    // VAD unavailable — transcription still works, just without silence-skipping.
  }
  for (const id of ["sherpa-segmentation", "sherpa-embedding"] as const) {
    try {
      await download(id, (r, t) => onProgress(id, r, t));
    } catch {
      // Speaker detection is optional; the checkbox falls back if models are absent.
    }
  }
}

export async function ensureDiarizationAssets(
  onProgress: (id: AssetId, received: number, total: number) => void,
): Promise<void> {
  for (const id of ["sherpa-segmentation", "sherpa-embedding"] as const) {
    await download(id, (r, t) => onProgress(id, r, t));
  }
}
