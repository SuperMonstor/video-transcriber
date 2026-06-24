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
};

/**
 * Run whisper-cli, returning the path to its full JSON output. Reports 0–100
 * transcription progress parsed from whisper's progress callback lines.
 */
export async function runWhisper(
  p: WhisperParams,
  onPercent: (percent: number) => void,
  signal?: AbortSignal,
): Promise<string> {
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
  if (p.initialPrompt) {
    args.push("--prompt", p.initialPrompt);
  }

  await run(p.whisperCli, args, {
    signal,
    onLine: (line) => {
      // whisper prints "whisper_print_progress_callback: progress = NN%"
      const m = /progress\s*=\s*(\d+)%/.exec(line);
      if (m) onPercent(Number(m[1]));
    },
  });

  return `${p.outBase}.json`;
}
