export function App(): JSX.Element {
  // Placeholder shell for the scaffold. The real drag-drop UI, progress, and
  // export controls land in Task #3.
  const version = window.transcriber?.version ?? "unknown";

  return (
    <main className="app">
      <h1>Video Transcriber</h1>
      <p className="muted">
        Drag a debate video in to get a timestamped transcript for clip-finding.
      </p>
      <div className="dropzone">Drop zone (coming next)</div>
      <footer className="muted">Electron {version}</footer>
    </main>
  );
}
