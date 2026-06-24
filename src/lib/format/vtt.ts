import type { Transcript } from "../engine/types";
import { timestamp } from "./time";

/** WebVTT (.vtt). */
export function toVtt(t: Transcript): string {
  const cues = t.segments
    .map((s) => {
      const range = `${timestamp(s.start, ".")} --> ${timestamp(s.end, ".")}`;
      return `${range}\n${s.text}`;
    })
    .join("\n\n");
  return `WEBVTT\n\n${cues}\n`;
}
