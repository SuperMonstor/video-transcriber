import type { Transcript } from "../engine/types";
import { toChatGPT } from "./chatgpt";
import { toSrt } from "./srt";
import { toVtt } from "./vtt";

export { toChatGPT, toSrt, toVtt };

export type ExportFormat = "chatgpt" | "srt" | "vtt" | "json";

export const EXPORT_EXT: Record<ExportFormat, string> = {
  chatgpt: "md",
  srt: "srt",
  vtt: "vtt",
  json: "json",
};

/** Render a transcript to the given format's text. */
export function render(t: Transcript, format: ExportFormat): string {
  switch (format) {
    case "chatgpt":
      return toChatGPT(t);
    case "srt":
      return toSrt(t);
    case "vtt":
      return toVtt(t);
    case "json":
      return JSON.stringify(t, null, 2);
  }
}
