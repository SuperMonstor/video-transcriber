import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractAudio } from "./audio";
import { diarizationUnavailableReason, diarize, type DiarizeParams } from "./diarize";
import { normalize, type WhisperFullJson } from "./normalize";
import { resolveBinaries, resolveModelPath, resolveVadModel } from "./paths";
import { probeDuration } from "./probe";
import { assignSpeakers } from "./speakers";
import type { ModelName, ProgressFn, SpeakerTurn, Transcript, TranscribeOptions } from "./types";
import { runWhisper } from "./whisper";

const noop: ProgressFn = () => {};

// whisper.cpp alignment-head presets for DTW word timestamps. Only turbo:
// the app currently serves "medium" with turbo weights (model-manager), and a
// preset that doesn't match the loaded weights would align the wrong heads.
const DTW_PRESETS: Partial<Record<ModelName, string>> = {
  "large-v3-turbo": "large.v3.turbo",
};

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
    const whisper = await runWhisper(
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
        // Speaker detection matches words to speaker turns, so it needs
        // tighter word timing; costs ~30% more whisper time.
        dtwPreset: options.detectSpeakers ? DTW_PRESETS[model] : undefined,
      },
      (percent) => onProgress({ stage: "transcribe", percent }),
      signal,
    );

    const diarizeParams: DiarizeParams = {
      sherpaDiarize: binaries.sherpaDiarize,
      audioPath,
      segmentationModelPath: options.diarizationSegmentationModelPath,
      embeddingModelPath: options.diarizationEmbeddingModelPath,
      speakerCount: options.speakerCount,
    };
    // Diarization is optional: on any failure keep the plain transcript, but
    // tell the caller why speakers are missing instead of failing silently.
    let speakerTurns: SpeakerTurn[] = [];
    if (options.detectSpeakers) {
      const unavailable = diarizationUnavailableReason(diarizeParams);
      if (unavailable) {
        onProgress({ stage: "warning", message: `Speaker detection skipped: ${unavailable}.` });
      } else {
        onProgress({ stage: "diarize" });
        try {
          speakerTurns = await diarize(diarizeParams, signal);
          if (!speakerTurns.length) {
            onProgress({
              stage: "warning",
              message: "Speaker detection ran but found no speaker turns.",
            });
          }
        } catch (err) {
          if (signal?.aborted) throw err;
          // run() appends a stderr tail; keep the "exited with code" line + last stderr line.
          const lines = (err instanceof Error ? err.message : String(err))
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          const reason =
            lines.length > 1 ? `${lines[0]} ${lines[lines.length - 1]}` : (lines[0] ?? "unknown error");
          onProgress({ stage: "warning", message: `Speaker detection failed: ${reason}` });
        }
      }
    }

    onProgress({ stage: "normalize" });
    const raw = JSON.parse(await fs.readFile(whisper.jsonPath, "utf8")) as WhisperFullJson;
    let transcript = normalize(raw, {
      source: path.basename(videoPath),
      model,
      vadSegments: whisper.vadSegments,
    });
    // whisper's own end time is authoritative, but fall back to ffprobe.
    if (!transcript.duration && duration) transcript.duration = duration;
    if (options.detectSpeakers) {
      transcript = assignSpeakers(transcript, speakerTurns);
    }

    onProgress({ stage: "done", transcript });
    return transcript;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ stage: "error", message });
    throw err;
  }
}
