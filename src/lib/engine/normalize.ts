import type { Segment, Transcript, Word } from "./types";

/* ---- whisper-cli full JSON shape (only the fields we read) ---- */
type WhisperToken = {
  text: string;
  offsets: { from: number; to: number };
  t_dtw?: number; // centiseconds; -1 unless whisper ran with --dtw
};
type WhisperSegment = {
  text: string;
  offsets: { from: number; to: number };
  tokens?: WhisperToken[];
};
export type WhisperFullJson = {
  result?: { language?: string };
  transcription?: WhisperSegment[];
};

/** A speech chunk whisper's VAD kept, in original-audio seconds. */
export type VadSegment = { start: number; end: number };

const isSpecialToken = (t: string) => /^\[_.*\]$/.test(t.trim());

/*
 * With --vad, whisper.cpp transcribes only the speech chunks, laid end to end:
 * each chunk is [start, end + overlap] followed by a short silence. It maps
 * *segment* times back to the original audio but leaves *token* times on that
 * compressed timeline (upstream issue #3174), so word times drift further from
 * the audio the longer the file runs. We undo that here.
 */
const VAD_OVERLAP = 0.1;
const VAD_GAP = 0.1;
// Rebuilt token times must land this close to whisper's own segment times.
const VAD_CHECK_TOLERANCE = 2;

/** Map a compressed (speech-only) time back to the original audio, given VAD chunks. */
export function vadTimeMapper(vad: VadSegment[]): (t: number) => number {
  const chunks: { cStart: number; cEnd: number; start: number }[] = [];
  let c = 0;
  for (const s of vad) {
    const len = s.end - s.start + VAD_OVERLAP;
    chunks.push({ cStart: c, cEnd: c + len, start: s.start });
    c += len + VAD_GAP;
  }
  return (t) => {
    if (!chunks.length) return t;
    let lo = 0;
    let hi = chunks.length - 1;
    // Last chunk whose compressed start is <= t.
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (chunks[mid].cStart <= t) lo = mid;
      else hi = mid - 1;
    }
    const ch = chunks[lo];
    return ch.start + Math.max(0, Math.min(t, ch.cEnd) - ch.cStart);
  };
}

type RawWord = { start: number; end: number; text: string; segment: number };

/** Group subword tokens into words, in whisper's (possibly compressed) time. */
function rawWords(tx: WhisperSegment[]): RawWord[] {
  const words: RawWord[] = [];
  tx.forEach((seg, segIndex) => {
    const toks = (seg.tokens ?? []).filter((t) => !isSpecialToken(t.text));
    const useDtw = toks.length > 0 && toks.every((t) => (t.t_dtw ?? -1) >= 0);
    let cur: RawWord | null = null;
    for (const tok of toks) {
      // DTW gives a single, more accurate onset per token; keep whisper's own
      // duration for the word's length.
      const start = useDtw ? tok.t_dtw! / 100 : tok.offsets.from / 1000;
      const end = useDtw ? start + (tok.offsets.to - tok.offsets.from) / 1000 : tok.offsets.to / 1000;
      // A token whose text starts with a space (or the first token) begins a new word.
      if (tok.text.startsWith(" ") || cur === null) {
        if (cur && cur.text) words.push(cur);
        cur = { start, end, text: tok.text.trim(), segment: segIndex };
      } else {
        cur.text += tok.text;
        cur.end = Math.max(cur.end, end);
      }
    }
    if (cur && cur.text) words.push(cur);
  });
  // DTW onsets are reliable; cap each word's end at the next word's start.
  for (let i = 0; i + 1 < words.length; i++) {
    if (words[i].end > words[i + 1].start) words[i].end = Math.max(words[i].start, words[i + 1].start);
  }
  return words;
}

/**
 * Fallback when the VAD layout can't be rebuilt: stretch each segment's words
 * linearly onto that segment's (already remapped) start/end.
 */
function fitToSegments(words: RawWord[], segments: Segment[]): RawWord[] {
  const bySeg = new Map<number, RawWord[]>();
  for (const w of words) bySeg.set(w.segment, [...(bySeg.get(w.segment) ?? []), w]);
  const out: RawWord[] = [];
  for (const [segIndex, ws] of bySeg) {
    const seg = segments[segIndex];
    const a = Math.min(...ws.map((w) => w.start));
    const b = Math.max(...ws.map((w) => w.end));
    const scale = b > a ? (seg.end - seg.start) / (b - a) : 0;
    for (const w of ws) {
      out.push({ ...w, start: seg.start + (w.start - a) * scale, end: seg.start + (w.end - a) * scale });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

function remapWords(words: RawWord[], segments: Segment[], vad: VadSegment[]): RawWord[] {
  if (!vad.length) return fitToSegments(words, segments);
  const map = vadTimeMapper(vad);
  const mapped = words.map((w) => ({ ...w, start: map(w.start), end: map(w.end) }));
  // Sanity-check the rebuild against whisper's own segment mapping; if the
  // layout constants ever change upstream, fall back to the per-segment fit.
  const inRange = mapped.filter((w) => {
    const seg = segments[w.segment];
    return w.start >= seg.start - VAD_CHECK_TOLERANCE && w.end <= seg.end + VAD_CHECK_TOLERANCE;
  }).length;
  return inRange >= 0.95 * mapped.length ? mapped : fitToSegments(words, segments);
}

/**
 * Convert whisper's full JSON into our normalized transcript (segments + words).
 * Pass `vadSegments` when whisper ran with --vad (see `runWhisper`) so word
 * times can be mapped back onto the original audio.
 */
export function normalize(
  raw: WhisperFullJson,
  meta: { source: string; model: string; vadSegments?: VadSegment[] },
): Transcript {
  const tx = raw.transcription ?? [];

  const segments: Segment[] = tx.map((s, i) => ({
    id: i,
    start: s.offsets.from / 1000,
    end: s.offsets.to / 1000,
    text: s.text.trim(),
  }));

  let words = rawWords(tx);
  if (meta.vadSegments) words = remapWords(words, segments, meta.vadSegments);

  const duration = segments.length ? segments[segments.length - 1].end : 0;

  return {
    source: meta.source,
    model: meta.model,
    language: raw.result?.language ?? "en",
    duration,
    createdAt: new Date().toISOString(),
    segments,
    words: words
      .filter((w) => w.text.length > 0)
      .map(({ start, end, text, segment }) => ({ start, end, text, segment })),
  };
}
