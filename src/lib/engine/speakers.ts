import type { Segment, SpeakerTurn, Transcript, Word } from "./types";

// A word in a gap between turns takes the nearest turn within this distance.
const NEAREST_TURN_MAX_GAP = 1.0;
// A speaker change inside a segment must last at least this many words to split it.
const MIN_RUN_WORDS = 3;

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function bestSpeakerForRange(
  start: number,
  end: number,
  turns: SpeakerTurn[],
): string | undefined {
  const scores = new Map<string, number>();
  for (const turn of turns) {
    const amount = overlap(start, end, turn.start, turn.end);
    if (amount > 0) scores.set(turn.speaker, (scores.get(turn.speaker) ?? 0) + amount);
  }

  let best: string | undefined;
  let bestScore = 0;
  for (const [speaker, score] of scores) {
    if (score > bestScore) {
      best = speaker;
      bestScore = score;
    }
  }
  if (best) return best;

  // No overlap (zero-length word, or a word in a short gap between turns).
  let nearest: string | undefined;
  let nearestGap = NEAREST_TURN_MAX_GAP;
  for (const turn of turns) {
    const gap = Math.max(turn.start - end, start - turn.end, 0);
    if (gap <= nearestGap) {
      nearest = turn.speaker;
      nearestGap = gap;
    }
  }
  return nearest;
}

function majoritySpeaker(words: Word[]): string | undefined {
  const scores = new Map<string, number>();
  for (const w of words) {
    if (w.speaker) scores.set(w.speaker, (scores.get(w.speaker) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestScore = 0;
  for (const [speaker, score] of scores) {
    if (score > bestScore) {
      best = speaker;
      bestScore = score;
    }
  }
  return best;
}

type Run = { speaker: string | undefined; words: Word[] };

/** Consecutive same-speaker runs, with runs shorter than MIN_RUN_WORDS absorbed. */
function speakerRuns(words: Word[]): Run[] {
  const runs: Run[] = [];
  for (const w of words) {
    const last = runs[runs.length - 1];
    if (last && (last.speaker === w.speaker || !w.speaker)) last.words.push(w);
    else runs.push({ speaker: w.speaker, words: [w] });
  }
  // Absorb short runs into the longer neighbour, repeatedly, so a one-word
  // flip doesn't split a line in two.
  for (;;) {
    let shortest = -1;
    for (let i = 0; i < runs.length; i++) {
      if (runs.length > 1 && runs[i].words.length < MIN_RUN_WORDS) {
        if (shortest < 0 || runs[i].words.length < runs[shortest].words.length) shortest = i;
      }
    }
    if (shortest < 0) break;
    const prev = runs[shortest - 1];
    const next = runs[shortest + 1];
    const into = !next || (prev && prev.words.length >= next.words.length) ? prev : next;
    if (into === prev) prev.words.push(...runs[shortest].words);
    else next.words.unshift(...runs[shortest].words);
    runs.splice(shortest, 1);
    // Merge neighbours that now share a speaker.
    for (let i = runs.length - 1; i > 0; i--) {
      if (runs[i].speaker === runs[i - 1].speaker) {
        runs[i - 1].words.push(...runs[i].words);
        runs.splice(i, 1);
      }
    }
  }
  return runs;
}

/**
 * Split a segment wherever the speaker changes between its words. Each part
 * keeps the segment's outer start/end; inner boundaries come from word times.
 */
function splitSegment(segment: Segment, words: Word[]): { segment: Segment; words: Word[] }[] {
  const runs = speakerRuns(words);
  if (runs.length <= 1) {
    const speaker = runs[0]?.speaker;
    return [{ segment: speaker ? { ...segment, speaker } : segment, words }];
  }
  return runs.map((run, i) => {
    const start = i === 0 ? segment.start : run.words[0].start;
    const end = i === runs.length - 1 ? segment.end : runs[i + 1].words[0].start;
    const part: Segment = {
      id: segment.id, // renumbered by the caller
      start,
      end: Math.max(start, end),
      text: run.words.map((w) => w.text).join(" "),
    };
    return { segment: run.speaker ? { ...part, speaker: run.speaker } : part, words: run.words };
  });
}

/**
 * Apply user-chosen display names to speaker labels (raw label → name), on
 * segments and words alike. Labels without a name are left as-is; mapping two
 * labels to the same name effectively merges them. Pure — returns a new transcript.
 */
export function renameSpeakers(
  transcript: Transcript,
  names: Readonly<Record<string, string>>,
): Transcript {
  if (!Object.keys(names).length) return transcript;
  const rename = <T extends { speaker?: string }>(item: T): T =>
    item.speaker && Object.hasOwn(names, item.speaker)
      ? { ...item, speaker: names[item.speaker] }
      : item;
  return {
    ...transcript,
    segments: transcript.segments.map(rename),
    words: transcript.words.map(rename),
  };
}

export function assignSpeakers(transcript: Transcript, turns: SpeakerTurn[]): Transcript {
  if (!turns.length) return transcript;

  const labelled = transcript.words.map((word) => {
    const speaker = bestSpeakerForRange(word.start, word.end, turns);
    return speaker ? { ...word, speaker } : word;
  });

  const wordsBySegment = new Map<number, Word[]>();
  const loose: Word[] = []; // words with no segment id
  for (const w of labelled) {
    if (w.segment === undefined) loose.push(w);
    else wordsBySegment.set(w.segment, [...(wordsBySegment.get(w.segment) ?? []), w]);
  }

  const segments: Segment[] = [];
  const words: Word[] = [...loose];
  for (const segment of transcript.segments) {
    const own = wordsBySegment.get(segment.id) ?? [];
    const parts = majoritySpeaker(own)
      ? splitSegment(segment, own)
      : (() => {
          // No word-level speakers: fall back to time overlap for the whole segment.
          const speaker = bestSpeakerForRange(segment.start, segment.end, turns);
          return [{ segment: speaker ? { ...segment, speaker } : segment, words: own }];
        })();
    for (const part of parts) {
      const id = segments.length;
      segments.push({ ...part.segment, id });
      for (const w of part.words) words.push({ ...w, segment: id });
    }
  }
  words.sort((a, b) => a.start - b.start);

  return { ...transcript, segments, words };
}
