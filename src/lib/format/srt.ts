import type { Transcript } from "../engine/types";
import { timestamp } from "./time";

/** Standard SubRip (.srt) — for subtitles / cutting clips. */
export function toSrt(t: Transcript): string {
  return (
    t.segments
      .map((s, i) => {
        const range = `${timestamp(s.start, ",")} --> ${timestamp(s.end, ",")}`;
        return `${i + 1}\n${range}\n${s.text}`;
      })
      .join("\n\n") + "\n"
  );
}
