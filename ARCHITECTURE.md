# Video Transcriber — Architecture

A local-first desktop tool for the debate club. Drop in a debate video → get an
accurate-enough, timestamped transcript → use it (in ChatGPT) to find **key
moments and hooks** worth cutting into **Instagram clips**.

The transcript is an **index into the video**, not the end product. The clip is.
So it needs to be good enough for ChatGPT to spot strong moments, with timestamps
precise enough to locate and trim them.

Status: **planning / blueprint**. No app code yet.

---

## 1. Goals & non-goals

**Goals (Phase 1)**
- Take a **local video file** → produce a transcript with **word- and
  segment-level timestamps**.
- Accuracy: **"good enough" for highlight/hook-finding**, not court-transcript
  perfection.
- Export **ChatGPT-ready** output (and `.srt`/`.vtt` for clipping/subtitles),
  formatted so ChatGPT can hand back timestamped hook candidates.
- Run **fully locally** — no cloud, no per-minute cost, footage never leaves the
  machine.
- Ship as a **packaged, auto-updating desktop app** for both team machines:
  **M4 Mac (Metal)** and a **Windows laptop w/ GTX 1650** — built and tested
  **remotely** (we can't share a machine).

**Non-goals (for now)**
- Speaker identification / diarization → **Phase 2** (§8).
- In-app highlight detection / clipping UI → the transcript feeds ChatGPT for that.
- Maximum transcription accuracy → not needed for clip-finding (§2).

---

## 2. Key decisions (and why)

| Decision | Choice | Why |
|---|---|---|
| Transcription engine | **whisper.cpp** (`whisper-cli` binary) | Proven in our `roughcut` projects. Tiny C++ binary, no Python/PyTorch, Metal on Apple Silicon, cross-platform. |
| Model | **`large-v3-turbo`** on both machines; **`medium`** speed-fallback | Turbo = near-large accuracy, much faster. Clip-finding doesn't need full `large-v3`, so we don't pay for it. |
| Audio extraction | **ffmpeg** → 16 kHz mono PCM WAV | Whisper's expected input; same as roughcut. |
| Hallucination control | **VAD (Silero)** | Whisper invents text during silence/applause/crosstalk → **phantom "moments."** VAD strips non-speech first. |
| Decoding | **Beam search (`-bs 5`)** | Slightly better word choices than greedy, modest cost. |
| Domain accuracy | **Initial prompt** w/ debate vocab + speaker names | Helps proper nouns / terms-of-art for cleaner hooks. |
| Timestamps | **Word + segment level** | Word-level lets you trim a clip precisely to the hook line. |
| Diarization | **Deferred to Phase 2** | The heavy part (PyTorch/pyannote). Structured formats get speaker attribution free from timestamps + known order (§8). |
| App shell | **Electron** (Node/TypeScript) | Reuses roughcut's TS pipeline + `child_process` spawning of `whisper-cli` unchanged. First-class packaging + auto-update. Its ~150 MB base is irrelevant next to the 1.6 GB model. |
| Distribution | **Public GitHub repo → Actions builds → Releases** | Public repo = **unlimited free Actions minutes** + free Release hosting/bandwidth. Tag a version → CI builds Mac + Windows → auto-update both. |
| Auto-update | **`electron-updater`** reading GitHub Releases | Solved path. Model is **excluded from the update payload** (downloaded first-run) so each update is ~100–200 MB, not 1.6 GB. |
| Cloud APIs | **Rejected** | Local whisper.cpp removes recurring cost and keeps footage private. |

> Rejected alternatives, briefly: **WhisperX + pyannote** drags in PyTorch/CUDA
> (~2–3 GB) + painful packaging, justified only by diarization → Phase 2 instead.
> **Cloud transcription APIs** are cheap but recurring + send footage off-machine.
> **`--tinydiarize`** forces the weak `small.en` model and only marks turn changes
> unreliably → not worth it (§8). **Full `large-v3`** = accuracy we won't use for
> clip-finding. **Tauri** = tiny binaries but Rust backend loses our TS reuse.

---

## 3. High-level flow

```
video file
   │
   ▼  ffprobe        → duration, fps  (probe)
   ▼  ffmpeg         → 16 kHz mono WAV (audio extract)
   ▼  whisper-cli    → JSON: segments + per-token timestamps (transcribe)
   │     flags: -m <turbo> --vad --vad-model <silero> -bs 5 -l en -ojf
   ▼  normalize      → Transcript { segments[], words[] }
   ▼  format         → ChatGPT .md  /  .srt  /  .vtt  /  raw .json
   ▼
export / copy → paste into ChatGPT → "find me hooks + timestamps"
```

---

## 4. Layered architecture

Guiding principle: **the engine knows nothing about Electron or the UI.**
Everything talks through one narrow boundary, so the shell stays thin and the
engine is reusable (CLI smoke test, Electron, future anything).

**Layer 1 — Engine** (pure TS, no Electron imports — the only hard part)
Video path + options → structured `Transcript`. Device auto-detection (Metal on
Mac, CUDA/CPU on the 1650) and model flags live here.

**Layer 2 — Job orchestration**
Transcription takes *minutes*. Jobs run in the background, emit **progress events**
(stage + percent, parsed from whisper-cli `-pp`), support **cancel**. UI never
freezes.

**Layer 3 — Formatters** (pure functions)
`Transcript` → ChatGPT `.md` (`[HH:MM:SS] text`), `.srt`, `.vtt`, raw `.json`.

**Layer 4 — Electron shell**
- **Main process** (Node): app lifecycle, owns the engine, IPC handlers, the
  updater, and first-run model download.
- **Preload**: `contextBridge` exposes a safe, minimal API to the UI.
- **Renderer** (web UI): drag-drop, progress bar, transcript view, export buttons.

**Layer 5 — Packaging & updates**
`electron-builder` → `.dmg`/`.zip` (Mac) + NSIS `.exe` (Windows). `electron-updater`
checks GitHub Releases on launch. **Binaries bundled** (whisper-cli, ffmpeg);
**model downloaded first-run** and cached in app-data (kept out of updates).

---

## 5. Engine interface

```ts
// types.ts — the contract every layer agrees on
export type Word    = { start: number; end: number; text: string };
export type Segment = { id: number; start: number; end: number; text: string };
// Phase 2 adds optional `speaker?: string` to Segment/Word — additive, no breakage.

export type Transcript = {
  source: string;          // original video path
  model: string;           // e.g. "large-v3-turbo"
  language: string;        // "en"
  duration: number;        // seconds
  createdAt: string;       // ISO timestamp
  segments: Segment[];
  words: Word[];
};

export type TranscribeOptions = {
  model?: "large-v3-turbo" | "medium";   // default: large-v3-turbo
  language?: string;                       // default: "en"
  vad?: boolean;                           // default: true
  beamSize?: number;                       // default: 5
  initialPrompt?: string;                  // debate vocab + speaker names
};

export type Progress =
  | { stage: "probe"      }
  | { stage: "audio"      }
  | { stage: "transcribe"; percent: number }   // parsed from whisper -pp
  | { stage: "normalize"  }
  | { stage: "done"; transcript: Transcript }
  | { stage: "error"; message: string };

// The one function the rest of the app calls.
export function transcribe(
  videoPath: string,
  options: TranscribeOptions,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<Transcript>;
```

`normalize` reuses roughcut's token-grouping logic (space-prefixed token starts a
new word; ms offsets → seconds; special `[_...]` tokens filtered).

---

## 6. Proposed folder structure

```
video-transcriber/
├─ ARCHITECTURE.md
├─ package.json
├─ electron-builder.yml             # targets + publish: github
├─ .github/workflows/release.yml    # tag → build mac+win → publish to Releases
├─ build/                           # icons, entitlements
├─ resources/bin/                   # bundled whisper-cli + ffmpeg, per platform
├─ src/
│  ├─ main/                         # Electron main process (Node)
│  │  ├─ main.ts                    # lifecycle, window
│  │  ├─ ipc.ts                     # IPC → engine
│  │  ├─ updater.ts                 # electron-updater
│  │  └─ model-manager.ts           # first-run model download + cache
│  ├─ preload/preload.ts            # contextBridge: safe API to renderer
│  ├─ renderer/                     # UI (the web layer)
│  │  ├─ index.html
│  │  ├─ App.tsx                    # drag-drop, progress, results, export
│  │  └─ components/
│  └─ lib/                          # the engine — pure, NO electron imports
│     ├─ engine/
│     │  ├─ types.ts
│     │  ├─ probe.ts                # ffprobe → duration/fps
│     │  ├─ audio.ts                # ffmpeg → 16 kHz mono wav
│     │  ├─ whisper.ts              # build flags, spawn whisper-cli
│     │  ├─ normalize.ts            # whisper JSON → Transcript
│     │  ├─ run.ts                  # spawn helper + progress parsing
│     │  └─ transcribe.ts           # orchestrates stages, emits Progress
│     ├─ format/{chatgpt,srt,vtt,index}.ts
│     └─ jobs/store.ts              # job registry: status, progress, cancel
└─ scripts/
   └─ smoke.ts                      # local engine smoke test on the Mac
```

---

## 7. The whisper-cli invocation (reference)

```
whisper-cli \
  -m models/ggml-large-v3-turbo.bin \
  -f audio.wav \
  -of out -ojf            # full JSON: segments + per-token timestamps
  -l en \
  -bs 5                   # beam search width 5
  --vad \
  --vad-model models/ggml-silero-v5.1.2.bin \
  --prompt "<debate vocabulary + speaker names>" \
  -pp -t <threads>
```

Per-platform binaries: Mac = Metal build (default on Apple Silicon). Windows =
**start with the CPU build for M1** (guaranteed to run, gives a baseline timing on
the 1650), then add the **cuBLAS/CUDA build** in M3 if CPU is too slow. Get it
running before optimizing.

---

## 8. Phase 2 — speaker attribution (deferred, designed-for)

1. **Structured formats (free, no model).** Fixed-order debate (BP: PM, LO, DPM,
   DLO… in known time slots) → timestamps already map onto speakers. Tell ChatGPT
   the format + order, or insert boundaries at known transition times. 100%
   accurate, zero added weight.
2. **Unstructured audio (real diarization).** Open crossfire, Q&A, panels → need
   **pyannote** (the PyTorch-heavy piece), isolated here so it never burdens Phase
   1. Adds `speaker?` to `Segment`/`Word` (already reserved, §5) — purely additive.

---

## 9. Build order / milestones

Reordered around the remote constraint: **we can't test on the 1650 ourselves, so
the first deliverable is a packaged build the friend runs.** No throwaway CLI.

- **M1 — Thin packaged slice (Mac + Windows).** Drag video → transcribe (turbo,
  Windows CPU build) → show transcript → export. First-run downloads the model.
  *Goal: prove the chain runs on the 1650 and get real timing.* (Engine gets a
  quick local smoke test on the Mac first — free, catches dumb bugs.)
- **M2 — Auto-updater + CI.** `electron-updater` + GitHub Actions → Releases. Now
  every fix reaches the friend automatically — pays for itself instantly given
  remote iteration.
- **M3 — Accuracy + UX:** VAD, beam search, debate prompt, Windows CUDA build,
  transcript view, export formats — shipped as auto-updates.
- **Phase 2 — diarization** per §8.

---

## 10. Risks & open questions

- **1650 speed (CPU build, M1).** CPU is the safe baseline; if too slow, CUDA
  build in M3. Measure first.
- **1650 VRAM (4 GB)** only matters once we add the CUDA build — `large-v3-turbo`
  should fit; `medium` fallback if not.
- **Code signing.** Unsigned builds trigger Windows SmartScreen / Mac Gatekeeper
  warnings (and Mac auto-update technically wants signing). Acceptable for a
  2-person team initially; revisit if we widen distribution.
- **Long videos.** Memory/time for 1 hr+ footage — validate in M1; VAD helps.
- **First-run model download UX.** ~1.6 GB on first launch — needs a clear
  progress/explanation screen so it doesn't look frozen.

_All earlier open questions (engine, model, shell, distribution) are now resolved
in §2._
```
