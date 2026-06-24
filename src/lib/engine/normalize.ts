import type { Segment, Transcript, Word } from "./types";

/* ---- whisper-cli full JSON shape (only the fields we read) ---- */
type WhisperToken = { text: string; offsets: { from: number; to: number } };
type WhisperSegment = {
  text: string;
  offsets: { from: number; to: number };
  tokens?: WhisperToken[];
};
export type WhisperFullJson = {
  result?: { language?: string };
  transcription?: WhisperSegment[];
};

const isSpecialToken = (t: string) => /^\[_.*\]$/.test(t.trim());

/** Convert whisper's full JSON into our normalized transcript (segments + words). */
export function normalize(
  raw: WhisperFullJson,
  meta: { source: string; model: string },
): Transcript {
  const tx = raw.transcription ?? [];

  const segments: Segment[] = tx.map((s, i) => ({
    id: i,
    start: s.offsets.from / 1000,
    end: s.offsets.to / 1000,
    text: s.text.trim(),
  }));

  // Group subword tokens into words: a token whose text starts with a space
  // (or the first token) begins a new word.
  const words: Word[] = [];
  let cur: Word | null = null;
  for (const seg of tx) {
    for (const tok of seg.tokens ?? []) {
      if (isSpecialToken(tok.text)) continue;
      const start = tok.offsets.from / 1000;
      const end = tok.offsets.to / 1000;
      if (tok.text.startsWith(" ") || cur === null) {
        if (cur && cur.text) words.push(cur);
        cur = { start, end, text: tok.text.trim() };
      } else {
        cur.text += tok.text;
        cur.end = end;
      }
    }
  }
  if (cur && cur.text) words.push(cur);

  const duration = segments.length ? segments[segments.length - 1].end : 0;

  return {
    source: meta.source,
    model: meta.model,
    language: raw.result?.language ?? "en",
    duration,
    createdAt: new Date().toISOString(),
    segments,
    words: words.filter((w) => w.text.length > 0),
  };
}
