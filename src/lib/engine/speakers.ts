import type { Segment, SpeakerTurn, Transcript, Word } from "./types";

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
  return best;
}

function speakerForSegment(segment: Segment, words: Word[], turns: SpeakerTurn[]): string | undefined {
  const scores = new Map<string, number>();
  for (const word of words) {
    if (!word.speaker) continue;
    const amount = overlap(segment.start, segment.end, word.start, word.end);
    if (amount > 0) scores.set(word.speaker, (scores.get(word.speaker) ?? 0) + amount);
  }

  let best: string | undefined;
  let bestScore = 0;
  for (const [speaker, score] of scores) {
    if (score > bestScore) {
      best = speaker;
      bestScore = score;
    }
  }

  return best ?? bestSpeakerForRange(segment.start, segment.end, turns);
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

  const words = transcript.words.map((word) => {
    const speaker = bestSpeakerForRange(word.start, word.end, turns);
    return speaker ? { ...word, speaker } : word;
  });

  const segments = transcript.segments.map((segment) => {
    const speaker = speakerForSegment(segment, words, turns);
    return speaker ? { ...segment, speaker } : segment;
  });

  return { ...transcript, segments, words };
}
