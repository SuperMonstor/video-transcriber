import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractAudio } from "./audio";
import { normalize, type WhisperFullJson } from "./normalize";
import { resolveBinaries, resolveModelPath, resolveVadModel } from "./paths";
import { probeDuration } from "./probe";
import type { ProgressFn, Transcript, TranscribeOptions } from "./types";
import { runWhisper } from "./whisper";

const noop: ProgressFn = () => {};

/**
 * Transcribe a video: ffprobe → ffmpeg (audio) → whisper-cli → normalized
 * Transcript. Emits progress through `onProgress`; resolves with the transcript
 * (also emitted as a final `done` event). Throws on failure (after emitting
 * `error`); aborting `signal` cancels the underlying processes.
 */
export async function transcribe(
  videoPath: string,
  options: TranscribeOptions = {},
  onProgress: ProgressFn = noop,
  signal?: AbortSignal,
): Promise<Transcript> {
  const model = options.model ?? "large-v3-turbo";
  const language = options.language ?? "en";
  const beamSize = options.beamSize ?? 5;
  const threads = options.threads ?? Math.min(10, Math.max(1, os.cpus()?.length ?? 4));
  const binaries = options.binaries ?? resolveBinaries();
  const modelPath = options.modelPath ?? resolveModelPath(model);
  const vadEnabled = options.vad ?? true;
  const vadModelPath = vadEnabled ? (options.vadModelPath ?? resolveVadModel()) : null;

  const workDir =
    options.workDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "video-transcriber-")));
  await fs.mkdir(workDir, { recursive: true });
  const audioPath = path.join(workDir, "audio.wav");
  const outBase = path.join(workDir, "whisper");

  try {
    onProgress({ stage: "probe" });
    const duration = await probeDuration(binaries.ffprobe, videoPath).catch(() => 0);

    onProgress({ stage: "audio" });
    await extractAudio(binaries.ffmpeg, videoPath, audioPath, signal);

    onProgress({ stage: "transcribe", percent: 0 });
    const jsonPath = await runWhisper(
      {
        whisperCli: binaries.whisperCli,
        modelPath,
        audioPath,
        outBase,
        language,
        beamSize,
        threads,
        vadModelPath,
        initialPrompt: options.initialPrompt,
      },
      (percent) => onProgress({ stage: "transcribe", percent }),
      signal,
    );

    onProgress({ stage: "normalize" });
    const raw = JSON.parse(await fs.readFile(jsonPath, "utf8")) as WhisperFullJson;
    const transcript = normalize(raw, { source: path.basename(videoPath), model });
    // whisper's own end time is authoritative, but fall back to ffprobe.
    if (!transcript.duration && duration) transcript.duration = duration;

    onProgress({ stage: "done", transcript });
    return transcript;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ stage: "error", message });
    throw err;
  }
}
