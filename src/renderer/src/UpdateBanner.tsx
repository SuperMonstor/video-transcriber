import { useEffect, useState } from "react";

import type { UpdateStatus } from "../../shared/ipc";

/**
 * Shows a slim banner when a new version has finished downloading, with a
 * one-click restart. Stays silent during checking/downloading.
 */
export function UpdateBanner(): JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    return window.transcriber.onUpdateStatus((s: UpdateStatus) => {
      if (s.state === "downloaded") setVersion(s.version);
    });
  }, []);

  if (!version) return null;

  return (
    <div className="update-banner">
      <span>Version {version} is ready.</span>
      <button onClick={() => window.transcriber.restartToUpdate()}>Restart &amp; update</button>
    </div>
  );
}
