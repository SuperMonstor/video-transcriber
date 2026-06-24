import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

/** Read a media file's duration in seconds via ffprobe (0 if unknown). */
export async function probeDuration(ffprobe: string, file: string): Promise<number> {
  const { stdout } = await pExecFile(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const d = parseFloat(stdout.trim());
  return Number.isFinite(d) ? d : 0;
}
