import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { renameSpeakers } from "../../lib/engine/speakers";
import type { ModelName, Transcript } from "../../lib/engine/types";
import { render, toChatGPT } from "../../lib/format";
import { hms } from "../../lib/format/time";
import type { ProgressMsg } from "../../shared/ipc";
import { ConfirmDialog } from "./ConfirmDialog";

const MAX_SPEAKER_NAME = 40;

type Status = "idle" | "running" | "done" | "error";

const STAGE_LABEL: Record<string, string> = {
  setup: "Preparing models…",
  probe: "Reading video…",
  audio: "Extracting audio…",
  transcribe: "Transcribing…",
  diarize: "Detecting speakers…",
  normalize: "Finishing up…",
};

export function App(): JSX.Element {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [model, setModel] = useState<ModelName>("large-v3-turbo");
  const [detectSpeakers, setDetectSpeakers] = useState(false);

  const [status, setStatus] = useState<Status>("idle");
  const [stage, setStage] = useState<string>("");
  const [percent, setPercent] = useState(0);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  // Speaker renaming: raw diarization label (e.g. "speaker_00") → display name.
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  // The tag being edited: which row's tag shows the input, and which label it renames.
  const [editing, setEditing] = useState<{ segmentId: number; speaker: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  // Mirrors `editing` synchronously so Escape followed by the input's blur can't commit.
  const editingRef = useRef<{ segmentId: number; speaker: string } | null>(null);

  const jobId = useRef<string | null>(null);

  // What exports see: the transcript with display names applied.
  const named = useMemo(
    () => (transcript ? renameSpeakers(transcript, speakerNames) : null),
    [transcript, speakerNames],
  );
  const renames = Object.entries(speakerNames);
  const hasSpeakers = transcript?.segments.some((s) => s.speaker) ?? false;

  const startRename = (segmentId: number, speaker: string): void => {
    editingRef.current = { segmentId, speaker };
    setEditing({ segmentId, speaker });
    setDraft(speakerNames[speaker] ?? speaker);
  };

  const cancelRename = (): void => {
    editingRef.current = null;
    setEditing(null);
  };

  const commitRename = (): void => {
    const target = editingRef.current;
    if (!target) return;
    cancelRename();
    const name = draft.trim().slice(0, MAX_SPEAKER_NAME);
    setSpeakerNames((prev) => {
      const next = { ...prev };
      // Empty, or back to the original label → drop the rename for this speaker.
      if (!name || name === target.speaker) delete next[target.speaker];
      else next[target.speaker] = name;
      return next;
    });
  };

  const closeResetDialog = useCallback(() => setConfirmReset(false), []);
  const resetNames = useCallback(() => {
    setSpeakerNames({});
    setConfirmReset(false);
  }, []);

  // Route progress events for the active job into UI state.
  useEffect(() => {
    return window.transcriber.onProgress((msg: ProgressMsg) => {
      if (msg.jobId !== jobId.current) return;
      switch (msg.stage) {
        case "transcribe":
          setStage(STAGE_LABEL.transcribe);
          setPercent(msg.percent);
          break;
        case "done":
          setTranscript(msg.transcript);
          setStatus("done");
          setStage("");
          break;
        case "error":
          setError(msg.message);
          setStatus("error");
          break;
        case "warning":
          setWarnings((w) => [...w, msg.message]);
          break;
        default:
          setStage(STAGE_LABEL[msg.stage] ?? msg.stage);
          setPercent(0);
      }
    });
  }, []);

  const fileName = filePath ? filePath.split(/[\\/]/).pop()! : null;

  const pickFromDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) setFilePath(window.transcriber.pathForFile(file));
  }, []);

  const reset = () => {
    setTranscript(null);
    setError(null);
    setWarnings([]);
    setSpeakerNames({});
    cancelRename();
    setConfirmReset(false);
    setCopied(false);
    setSavedTo(null);
    setPercent(0);
    setStage("");
  };

  const startTranscription = useCallback(async () => {
    if (!filePath) return;
    reset();
    setStatus("running");
    // VAD is always on — it suppresses hallucinated text during silence, which
    // matters for clip-finding. Not exposed as a toggle (footgun if disabled).
    const { jobId: id } = await window.transcriber.start(filePath, {
      model,
      detectSpeakers,
    });
    jobId.current = id;
  }, [detectSpeakers, filePath, model]);

  const cancel = useCallback(async () => {
    if (jobId.current) await window.transcriber.cancel(jobId.current);
    jobId.current = null;
    setStatus("idle");
    setStage("");
  }, []);

  const copyChatGPT = useCallback(async () => {
    if (!named) return;
    await navigator.clipboard.writeText(toChatGPT(named));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [named]);

  const saveAs = useCallback(
    async (format: "srt" | "json") => {
      if (!named) return;
      const base = named.source.replace(/\.[^.]+$/, "");
      const path = await window.transcriber.save(render(named, format), `${base}.${format}`);
      if (path) setSavedTo(path);
    },
    [named],
  );

  return (
    <main className="app">
      <header>
        <h1>Video Transcriber</h1>
        <p className="muted">
          Drop a debate video to get a timestamped transcript for finding clips and hooks.
        </p>
      </header>

      <div
        className={`dropzone ${filePath ? "has-file" : ""}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={pickFromDrop}
      >
        {fileName ? (
          <>
            <strong>{fileName}</strong>
            <span className="muted">Drop another file to replace</span>
          </>
        ) : (
          "Drag a video file here"
        )}
      </div>

      <div className="controls">
        <label>
          Model
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as ModelName)}
            disabled={status === "running"}
          >
            <option value="large-v3-turbo">large-v3-turbo (recommended)</option>
            <option value="medium">medium (faster)</option>
          </select>
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={detectSpeakers}
            onChange={(e) => setDetectSpeakers(e.target.checked)}
            disabled={status === "running"}
          />
          Detect speakers (slower)
        </label>

        {status === "running" ? (
          <button className="danger" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button className="primary" onClick={startTranscription} disabled={!filePath}>
            Transcribe
          </button>
        )}
      </div>

      {status === "running" && (
        <div className="progress">
          <div className="bar">
            <div className="fill" style={{ width: `${percent}%` }} />
          </div>
          <span className="muted">
            {stage} {stage === STAGE_LABEL.transcribe ? `${percent}%` : ""}
          </span>
        </div>
      )}

      {status === "error" && <div className="error">{error}</div>}

      {warnings.length > 0 && status !== "idle" && (
        <div className="warning">
          {warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      {transcript && status === "done" && (
        <section className="result">
          <div className="result-head">
            <span className="muted">
              {transcript.segments.length} segments · {hms(transcript.duration)} · {transcript.model}
              {hasSpeakers && " · click a speaker tag to rename"}
            </span>
            <div className="exports">
              {renames.length > 0 && (
                <button onClick={() => setConfirmReset(true)}>Reset names</button>
              )}
              <button onClick={copyChatGPT}>{copied ? "Copied!" : "Copy for ChatGPT"}</button>
              <button onClick={() => saveAs("srt")}>Save .srt</button>
              <button onClick={() => saveAs("json")}>Save .json</button>
            </div>
          </div>
          {savedTo && <p className="muted saved">Saved to {savedTo}</p>}
          <ol className="segments">
            {transcript.segments.map((s) => (
              <li key={s.id}>
                <span className="ts">{hms(s.start)}</span>
                {s.speaker &&
                  (editing?.segmentId === s.id ? (
                    <input
                      className="speaker-input"
                      autoFocus
                      value={draft}
                      maxLength={MAX_SPEAKER_NAME}
                      size={Math.max(8, draft.length + 1)}
                      aria-label={`Rename ${s.speaker}`}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        else if (e.key === "Escape") cancelRename();
                      }}
                      onBlur={commitRename}
                    />
                  ) : (
                    <button
                      type="button"
                      className={`speaker${speakerNames[s.speaker] ? " renamed" : ""}`}
                      title={
                        speakerNames[s.speaker]
                          ? `${s.speaker} — click to rename`
                          : "Click to rename this speaker"
                      }
                      onClick={() => startRename(s.id, s.speaker!)}
                    >
                      {speakerNames[s.speaker] ?? s.speaker}
                    </button>
                  ))}
                <span>{s.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {confirmReset && (
        <ConfirmDialog
          title="Reset speaker names?"
          confirmLabel="Reset names"
          onConfirm={resetNames}
          onCancel={closeResetDialog}
        >
          <p>
            {renames.length === 1 ? "This rename" : `These ${renames.length} renames`} will be
            undone, and the transcript and exports will go back to the original labels:
          </p>
          <ul className="rename-list">
            {renames.map(([raw, name]) => (
              <li key={raw}>
                <strong>{name}</strong> → {raw}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
    </main>
  );
}
