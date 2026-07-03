import { useEffect, useState } from "react";

import type { SetupProgressMsg } from "../../shared/ipc";

const mb = (n: number) => `${(n / 1_048_576).toFixed(0)} MB`;

const LABELS: Record<string, string> = {
  "large-v3-turbo": "Transcription model",
  "silero-vad": "Voice-activity model",
  "sherpa-segmentation": "Speaker segmentation model",
  "sherpa-embedding": "Speaker embedding model",
};

export function Setup({ onReady }: { onReady: () => void }): JSX.Element {
  const [downloading, setDownloading] = useState(false);
  const [pct, setPct] = useState(0);
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState(0);
  const [label, setLabel] = useState("Transcription model");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return window.transcriber.onSetupProgress((m: SetupProgressMsg) => {
      if (m.phase === "error") {
        setError(m.message ?? "Download failed");
        setDownloading(false);
      } else if (m.phase === "downloading" && m.total) {
        setReceived(m.received);
        setTotal(m.total);
        setPct(Math.floor((m.received / m.total) * 100));
        setLabel(LABELS[m.id] ?? "Model asset");
      }
    });
  }, []);

  const start = async () => {
    setError(null);
    setDownloading(true);
    const { ready } = await window.transcriber.setupDownload();
    if (ready) onReady();
    else setDownloading(false);
  };

  return (
    <main className="app">
      <header>
        <h1>One-time setup</h1>
        <p className="muted">
          Video Transcriber needs to download the speech model (~1.6&nbsp;GB) the first
          time. Optional speaker-detection models are downloaded too when available.
          It runs fully offline after this — nothing is uploaded.
        </p>
      </header>

      {!downloading && !error && (
        <button className="primary setup-btn" onClick={start}>
          Download models (~1.7 GB)
        </button>
      )}

      {downloading && (
        <div className="progress">
          <div className="bar">
            <div className="fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="muted">
            {label} · {pct}% {total ? `(${mb(received)} / ${mb(total)})` : ""}
          </span>
        </div>
      )}

      {error && (
        <>
          <div className="error">{error}</div>
          <button className="primary setup-btn" onClick={start}>
            Retry
          </button>
        </>
      )}
    </main>
  );
}
