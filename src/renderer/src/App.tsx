import { useCallback, useEffect, useRef, useState } from "react";

import type { ModelName, Transcript } from "../../lib/engine/types";
import { render, toChatGPT } from "../../lib/format";
import { hms } from "../../lib/format/time";
import type { ProgressMsg } from "../../shared/ipc";

type Status = "idle" | "running" | "done" | "error";

const STAGE_LABEL: Record<string, string> = {
  probe: "Reading video…",
  audio: "Extracting audio…",
  transcribe: "Transcribing…",
  normalize: "Finishing up…",
};

export function App(): JSX.Element {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [model, setModel] = useState<ModelName>("large-v3-turbo");
  const [vad, setVad] = useState(true);

  const [status, setStatus] = useState<Status>("idle");
  const [stage, setStage] = useState<string>("");
  const [percent, setPercent] = useState(0);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  const jobId = useRef<string | null>(null);

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
    setCopied(false);
    setSavedTo(null);
    setPercent(0);
    setStage("");
  };

  const startTranscription = useCallback(async () => {
    if (!filePath) return;
    reset();
    setStatus("running");
    const { jobId: id } = await window.transcriber.start(filePath, { model, vad });
    jobId.current = id;
  }, [filePath, model, vad]);

  const cancel = useCallback(async () => {
    if (jobId.current) await window.transcriber.cancel(jobId.current);
    jobId.current = null;
    setStatus("idle");
    setStage("");
  }, []);

  const copyChatGPT = useCallback(async () => {
    if (!transcript) return;
    await navigator.clipboard.writeText(toChatGPT(transcript));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [transcript]);

  const saveAs = useCallback(
    async (format: "srt" | "json") => {
      if (!transcript) return;
      const base = transcript.source.replace(/\.[^.]+$/, "");
      const path = await window.transcriber.save(
        render(transcript, format),
        `${base}.${format}`,
      );
      if (path) setSavedTo(path);
    },
    [transcript],
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
            checked={vad}
            onChange={(e) => setVad(e.target.checked)}
            disabled={status === "running"}
          />
          Skip silence (VAD)
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

      {transcript && status === "done" && (
        <section className="result">
          <div className="result-head">
            <span className="muted">
              {transcript.segments.length} segments · {hms(transcript.duration)} · {transcript.model}
            </span>
            <div className="exports">
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
                <span>{s.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
