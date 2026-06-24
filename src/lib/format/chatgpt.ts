import type { Transcript } from "../engine/types";
import { hms } from "./time";

/**
 * ChatGPT-ready transcript: one timestamped line per segment, with a short
 * header. The format is designed so you can paste it in and ask for hooks /
 * highlights and get back timestamps you can jump to and clip.
 */
export function toChatGPT(t: Transcript): string {
  const header = [
    `# Transcript — ${t.source}`,
    `Duration ${hms(t.duration)} · model ${t.model} · ${t.segments.length} segments`,
    "",
    "Each line is [HH:MM:SS] followed by what was said. Use the timestamps to",
    "locate moments in the video.",
    "",
  ].join("\n");

  const body = t.segments.map((s) => `[${hms(s.start)}] ${s.text}`).join("\n");
  return `${header}\n${body}\n`;
}
