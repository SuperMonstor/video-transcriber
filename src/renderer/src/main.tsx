import { useEffect, useState } from "react";
import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { Setup } from "./Setup";
import "./styles.css";

function Root(): JSX.Element {
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    window.transcriber.setupStatus().then((s) => setReady(s.ready));
  }, []);

  if (ready === null) {
    return (
      <main className="app">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  return ready ? <App /> : <Setup onReady={() => setReady(true)} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
