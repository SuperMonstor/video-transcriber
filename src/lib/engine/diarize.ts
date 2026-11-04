import { existsSync } from "node:fs";

import { run } from "./run";
import type { SpeakerTurn } from "./types";

export type DiarizeParams = {
  sherpaDiarize?: string;
  audioPath: string;
  segmentationModelPath?: string | null;
  embeddingModelPath?: string | null;
  speakerCount?: number;
};

const TURN_RE = /^\s*(\d+(?:\.\d+)?)\s+--\s+(\d+(?:\.\d+)?)\s+(\S+)\s*$/;

/** Why diarization can't run, or null if everything it needs is present. */
export function diarizationUnavailableReason(p: DiarizeParams): string | null {
  if (!p.sherpaDiarize) return "the sherpa-onnx diarization binary is not configured";
  // A bare command name is resolved via PATH at spawn time; only check real paths.
  if (/[\\/]/.test(p.sherpaDiarize) && !existsSync(p.sherpaDiarize)) {
    return `the diarization binary was not found at ${p.sherpaDiarize}`;
  }
  if (!p.segmentationModelPath || !existsSync(p.segmentationModelPath)) {
    return "the speaker segmentation model is missing";
  }
  if (!p.embeddingModelPath || !existsSync(p.embeddingModelPath)) {
    return "the speaker embedding model is missing";
  }
  return null;
}

export function diarizationAvailable(p: DiarizeParams): boolean {
  return diarizationUnavailableReason(p) === null;
}

export function parseSpeakerTurn(line: string): SpeakerTurn | null {
  const match = TURN_RE.exec(line);
  if (!match) return null;

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  return { start, end, speaker: match[3] };
}

export async function diarize(
  p: DiarizeParams,
  signal?: AbortSignal,
): Promise<SpeakerTurn[]> {
  if (!diarizationAvailable(p)) return [];

  const args = [
    `--segmentation.pyannote-model=${p.segmentationModelPath!}`,
    `--embedding.model=${p.embeddingModelPath!}`,
  ];

  if (p.speakerCount && p.speakerCount > 0) {
    args.push(`--clustering.num-clusters=${p.speakerCount}`);
  } else {
    args.push("--clustering.cluster-threshold=0.9");
  }

  args.push(p.audioPath);

  const turns: SpeakerTurn[] = [];
  await run(p.sherpaDiarize!, args, {
    signal,
    onLine: (line) => {
      const turn = parseSpeakerTurn(line);
      if (turn) turns.push(turn);
    },
  });

  return turns;
}
