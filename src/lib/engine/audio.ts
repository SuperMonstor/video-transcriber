import { run } from "./run";

/** Extract 16 kHz mono PCM WAV — the format Whisper expects. */
export async function extractAudio(
  ffmpeg: string,
  srcPath: string,
  audioPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await run(
    ffmpeg,
    ["-y", "-i", srcPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", audioPath],
    { signal },
  );
}
