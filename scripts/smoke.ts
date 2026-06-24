/**
 * Headless engine smoke test (Mac dev). Runs the full pipeline against a real
 * video and prints stats + a preview of the ChatGPT export. No Electron, no GUI.
 *
 *   WHISPER_MODEL_DIR=/path/to/models npm run smoke -- /path/to/video.mp4
 *
 * Resolves whisper-cli / ffmpeg / ffprobe from PATH (override with WHISPER_CLI,
 * FFMPEG, FFPROBE). VAD is off unless WHISPER_VAD_MODEL is set.
 */
import { transcribe } from "../src/lib/engine/transcribe";
import type { Progress } from "../src/lib/engine/types";
import { toChatGPT } from "../src/lib/format/chatgpt";

async function main(): Promise<void> {
  const video = process.argv[2];
  if (!video) {
    console.error("usage: npm run smoke -- <video-file>");
    process.exit(1);
  }

  const vad = Boolean(process.env.WHISPER_VAD_MODEL);
  const startedAt = Date.now();

  const onProgress = (p: Progress) => {
    if (p.stage === "transcribe") {
      process.stdout.write(`\r  transcribe ${String(p.percent).padStart(3)}%   `);
    } else if (p.stage === "done") {
      process.stdout.write("\n");
    } else {
      console.log(`[${p.stage}]`);
    }
  };

  const t = await transcribe(video, { vad }, onProgress);

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\ndone in ${secs}s — ${t.segments.length} segments, ${t.words.length} words, ` +
      `${t.duration.toFixed(1)}s audio (vad=${vad})`,
  );
  console.log("\n--- ChatGPT export (first 1000 chars) ---\n");
  console.log(toChatGPT(t).slice(0, 1000));
}

main().catch((err) => {
  console.error("\nsmoke failed:", err);
  process.exit(1);
});
