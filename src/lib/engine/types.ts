// The engine contract. Pure types — no Electron, no Node specifics.

export type ModelName = "large-v3-turbo" | "medium";

export type Word = {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  segment?: number; // id of the Segment this word came from
};
export type Segment = { id: number; start: number; end: number; text: string; speaker?: string };
export type SpeakerTurn = { start: number; end: number; speaker: string };

export type Transcript = {
  source: string; // original video filename
  model: string; // e.g. "large-v3-turbo"
  language: string; // "en"
  duration: number; // seconds
  createdAt: string; // ISO timestamp
  segments: Segment[];
  words: Word[];
};

export type Binaries = {
  whisperCli: string;
  ffmpeg: string;
  ffprobe: string;
  sherpaDiarize?: string;
};

export type TranscribeOptions = {
  model?: ModelName; // default: large-v3-turbo
  language?: string; // default: "en"
  vad?: boolean; // default: true (skipped if no VAD model resolves)
  beamSize?: number; // default: 5
  initialPrompt?: string; // debate vocab + speaker names
  detectSpeakers?: boolean; // optional sherpa-onnx diarization path
  speakerCount?: number; // optional clustering hint for diarization
  threads?: number; // default: min(10, cpu count)
  workDir?: string; // intermediate wav/json location; default: a temp dir

  // Explicit path overrides. The app injects these (bundled binaries +
  // downloaded model); the smoke script and dev resolve from env instead.
  binaries?: Binaries;
  modelPath?: string;
  vadModelPath?: string | null;
  diarizationSegmentationModelPath?: string | null;
  diarizationEmbeddingModelPath?: string | null;
};

export type Progress =
  | { stage: "setup" }
  | { stage: "probe" }
  | { stage: "audio" }
  | { stage: "transcribe"; percent: number } // parsed from whisper -pp
  | { stage: "diarize" }
  | { stage: "warning"; message: string } // non-fatal, e.g. speaker detection skipped
  | { stage: "normalize" }
  | { stage: "done"; transcript: Transcript }
  | { stage: "error"; message: string };

export type ProgressFn = (p: Progress) => void;
