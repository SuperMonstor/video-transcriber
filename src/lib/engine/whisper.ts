import type { VadSegment } from "./normalize";
import { run } from "./run";

export type WhisperParams = {
  whisperCli: string;
  modelPath: string;
  audioPath: string;
  outBase: string; // whisper writes `${outBase}.json`
  language: string;
  beamSize: number;
  threads: number;
  vadModelPath: string | null;
  initialPrompt?: string;
  /** whisper.cpp DTW preset (e.g. "large.v3.turbo") for more accurate word timestamps. */
  dtwPreset?: string;
};

export type WhisperResult = {
  jsonPath: string;
  /** Speech chunks whisper's VAD kept (from its log); undefined when VAD is off. */
  vadSegments?: VadSegment[];
};

// whisper_vad_segments_from_probs: VAD segment 0: start = 0.51, end = 8.86 (duration: 8.35)
const VAD_SEGMENT_RE = /VAD segment \d+: start = ([\d.]+), end = ([\d.]+)/;

export function parseVadSegment(line: string): VadSegment | null {
  const m = VAD_SEGMENT_RE.exec(line);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

/**
 * Run whisper-cli, returning the path to its full JSON output and the VAD
 * speech chunks it used. Reports 0–100 transcription progress parsed from
 * whisper's progress callback lines.
 */
export async function runWhisper(
  p: WhisperParams,
  onPercent: (percent: number) => void,
  signal?: AbortSignal,
): Promise<WhisperResult> {
  const args = [
    "-m", p.modelPath,
    "-f", p.audioPath,
    "-of", p.outBase,
    "-ojf", // full JSON: segments + per-token timestamps
    "-l", p.language,
    "-bs", String(p.beamSize), // beam search width
    "-pp", // print progress
    "-t", String(p.threads),
  ];
  if (p.vadModelPath) {
    args.push("--vad", "--vad-model", p.vadModelPath);
  }
  if (p.dtwPreset) {
    // whisper.cpp silently disables DTW when flash attention is on.
    args.push("-nfa", "-dtw", p.dtwPreset);
  }
  if (p.initialPrompt) {
    args.push("--prompt", p.initialPrompt);
  }

  const vadSegments: VadSegment[] = [];
  await run(p.whisperCli, args, {
    signal,
    onLine: (line) => {
      // whisper prints "whisper_print_progress_callback: progress = NN%"
      const m = /progress\s*=\s*(\d+)%/.exec(line);
      if (m) onPercent(Number(m[1]));
      const seg = parseVadSegment(line);
      if (seg) vadSegments.push(seg);
    },
  });

  return { jsonPath: `${p.outBase}.json`, vadSegments: p.vadModelPath ? vadSegments : undefined };
}
