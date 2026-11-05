/**
 * Speaker-detection evaluation harness. Runs sherpa-onnx diarization over
 * hand-labelled clips for a grid of models/thresholds, pushes the result
 * through the app's own `normalize` + `assignSpeakers`, and scores it.
 *
 *   npx tsx scripts/eval-diarization.ts <labels.json> [options]
 *
 * Options (comma-separated lists):
 *   --models-dir <dir>   where the .onnx models live (default: dir of labels)
 *   --emb a.onnx,b.onnx  embedding models (relative to models dir)
 *   --seg a.onnx         segmentation models (relative to models dir)
 *   --thr 0.5,0.7        cluster thresholds
 *   --whisper base|dtw   which whisper JSON to score words from (default base)
 *   --extra "<args>"     extra sherpa args, e.g. "--min-duration-off=0.5"
 *   --app                ignore the grid; run the app's own `diarize()` defaults
 *   --jobs N             parallel sherpa runs (default 4)
 *
 * labels.json: { clips: [{ name, audio, whisper: { <kind>: { json, log } }, turns: [{start,end,speaker}], ignore: [[s,e]] }] }
 * `json` is whisper-cli's -ojf output and `log` its stderr (for the VAD segments).
 * Paths inside it are relative to the labels file.
 *
 * Metrics (per clip, then averaged):
 *   word  — % of words whose speaker matches the reference, after a one-to-one
 *           mapping of predicted speakers to reference speakers.
 *   seg   — same, per transcript segment (what the user sees on each line).
 *   spk   — predicted speaker count vs reference.
 * Words within 0.25s of a reference speaker change, or in `ignore`, are skipped.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { diarize, parseSpeakerTurn } from "../src/lib/engine/diarize";
import { normalize, type WhisperFullJson } from "../src/lib/engine/normalize";
import { run } from "../src/lib/engine/run";
import { parseVadSegment } from "../src/lib/engine/whisper";
import { assignSpeakers } from "../src/lib/engine/speakers";
import type { SpeakerTurn, Transcript } from "../src/lib/engine/types";

type Clip = {
  name: string;
  audio: string;
  whisper: Record<string, { json: string; log?: string }>;
  turns: SpeakerTurn[];
  ignore: [number, number][];
};

const COLLAR = 0.25;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const list = (s: string | undefined) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

const labelsPath = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(labelsPath)) {
  console.error("usage: npx tsx scripts/eval-diarization.ts <labels.json> [options]");
  process.exit(1);
}
const root = dirname(labelsPath);
const clips: Clip[] = JSON.parse(readFileSync(labelsPath, "utf8")).clips;
const modelsDir = resolve(arg("models-dir", join(root, "models"))!);
const sherpa =
  process.env.SHERPA_ONNX_DIARIZE ||
  resolve("resources/bin/mac/sherpa-onnx-offline-speaker-diarization");
const whisperKind = arg("whisper", "base")!;
const extra = list(arg("extra")?.replace(/\s+/g, ","));
const jobs = Number(arg("jobs", "4"));
const cacheDir = join(root, "eval-cache");
mkdirSync(cacheDir, { recursive: true });

type Config = { label: string; emb: string; seg: string; thr: number | null };

const appMode = process.argv.includes("--app");
const configs: Config[] = [];
if (appMode) {
  configs.push({
    label: "app defaults",
    emb: process.env.SHERPA_ONNX_EMBEDDING_MODEL ?? "",
    seg: process.env.SHERPA_ONNX_SEGMENTATION_MODEL ?? "",
    thr: null,
  });
} else {
  for (const emb of list(arg("emb", "nemo_en_titanet_small.onnx")))
    for (const seg of list(arg("seg", "sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx")))
      for (const thr of list(arg("thr", "0.9")).map(Number))
        configs.push({
          label: `${basename(emb, ".onnx")} | ${seg.includes("int8") ? "int8" : "fp32"} | ${thr}`,
          emb: join(modelsDir, emb),
          seg: join(modelsDir, seg),
          thr,
        });
}

async function diarizeCached(clip: Clip, c: Config): Promise<SpeakerTurn[]> {
  const audio = join(root, clip.audio);
  if (appMode) {
    return diarize({
      sherpaDiarize: sherpa,
      audioPath: audio,
      segmentationModelPath: c.seg,
      embeddingModelPath: c.emb,
    });
  }
  const args = [
    `--segmentation.pyannote-model=${c.seg}`,
    `--embedding.model=${c.emb}`,
    `--clustering.cluster-threshold=${c.thr}`,
    ...extra,
    audio,
  ];
  const key = createHash("sha1").update(args.join("\n")).digest("hex").slice(0, 16);
  const file = join(cacheDir, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const turns: SpeakerTurn[] = [];
  await run(sherpa, args, {
    onLine: (line) => {
      const t = parseSpeakerTurn(line);
      if (t) turns.push(t);
    },
  });
  writeFileSync(file, JSON.stringify(turns));
  return turns;
}

function refAt(clip: Clip, t: number): string | null {
  if (clip.ignore.some(([s, e]) => t >= s && t <= e)) return null;
  const turn = clip.turns.find((x) => t >= x.start && t < x.end);
  if (!turn) return null;
  // Skip a collar around reference speaker changes — boundary timing is fuzzy.
  for (const x of clip.turns) {
    if (x === turn) continue;
    if (Math.abs(t - x.start) < COLLAR || Math.abs(t - x.end) < COLLAR) return null;
  }
  return turn.speaker;
}

/** One-to-one mapping (greedy on co-occurrence counts), then % agreement. */
function mappedAccuracy(pairs: [string, string][]): number {
  if (!pairs.length) return 0;
  const counts = new Map<string, number>();
  for (const [ref, hyp] of pairs) counts.set(`${ref}\u0000${hyp}`, (counts.get(`${ref}\u0000${hyp}`) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const usedRef = new Set<string>();
  const usedHyp = new Set<string>();
  let correct = 0;
  for (const [k, n] of sorted) {
    const [ref, hyp] = k.split("\u0000");
    if (hyp === "∅" || usedRef.has(ref) || usedHyp.has(hyp)) continue;
    usedRef.add(ref);
    usedHyp.add(hyp);
    correct += n;
  }
  return correct / pairs.length;
}

function score(clip: Clip, t: Transcript) {
  const wordPairs: [string, string][] = [];
  for (const w of t.words) {
    const ref = refAt(clip, (w.start + w.end) / 2);
    if (ref) wordPairs.push([ref, w.speaker ?? "∅"]);
  }
  const segPairs: [string, string][] = [];
  for (const s of t.segments) {
    // Reference for a segment: the reference speaker covering most of it.
    const cover = new Map<string, number>();
    for (const x of clip.turns) {
      const o = Math.max(0, Math.min(s.end, x.end) - Math.max(s.start, x.start));
      if (o > 0) cover.set(x.speaker, (cover.get(x.speaker) ?? 0) + o);
    }
    const ref = [...cover.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const mid = (s.start + s.end) / 2;
    if (ref && !clip.ignore.some(([a, b]) => mid >= a && mid <= b)) segPairs.push([ref, s.speaker ?? "∅"]);
  }
  const hypSpeakers = new Set(t.words.map((w) => w.speaker).filter(Boolean)).size;
  const refSpeakers = new Set(clip.turns.map((x) => x.speaker)).size;
  const unlabeled = wordPairs.filter(([, h]) => h === "∅").length / Math.max(1, wordPairs.length);
  return { word: mappedAccuracy(wordPairs), seg: mappedAccuracy(segPairs), unlabeled, hypSpeakers, refSpeakers };
}

async function pool<T>(items: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await items[i]();
      }
    }),
  );
  return out;
}

async function main() {
  const transcripts = clips.map((clip) => {
    const w = clip.whisper[whisperKind];
    const raw = JSON.parse(readFileSync(join(root, w.json), "utf8")) as WhisperFullJson;
    const vadSegments = w.log
      ? readFileSync(join(root, w.log), "utf8").split("\n").map(parseVadSegment).filter((x) => x !== null)
      : undefined;
    return normalize(raw, { source: clip.name, model: "eval", vadSegments });
  });

  const tasks = configs.flatMap((c) => clips.map((clip, i) => async () => {
    const turns = await diarizeCached(clip, c);
    return { c, i, s: score(clip, assignSpeakers(transcripts[i], turns)) };
  }));
  const results = await pool(tasks, jobs);

  const pct = (x: number) => `${(x * 100).toFixed(1)}`.padStart(5);
  console.log(`whisper=${whisperKind}  extra=[${extra.join(" ")}]`);
  console.log(
    "config".padEnd(52) +
      clips.map((_, i) => `  c${i + 1} word/seg/spk`.padEnd(24)).join("") +
      "  mean word / seg / unlabeled",
  );
  for (const c of configs) {
    const rows = results.filter((r) => r.c === c).sort((a, b) => a.i - b.i);
    const cells = rows.map((r) => `  ${pct(r.s.word)}/${pct(r.s.seg)}/${r.s.hypSpeakers}:${r.s.refSpeakers}`.padEnd(24));
    const mw = rows.reduce((a, r) => a + r.s.word, 0) / rows.length;
    const ms = rows.reduce((a, r) => a + r.s.seg, 0) / rows.length;
    const mu = rows.reduce((a, r) => a + r.s.unlabeled, 0) / rows.length;
    console.log(c.label.padEnd(52) + cells.join("") + `  ${pct(mw)} / ${pct(ms)} / ${pct(mu)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
