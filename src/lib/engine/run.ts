import { spawn } from "node:child_process";

export type LineSink = (line: string, stream: "out" | "err") => void;

/**
 * Spawn a command, streaming stdout/stderr line-wise to `onLine`. Resolves on
 * exit code 0, rejects otherwise (with a tail of stderr for context). Pass an
 * AbortSignal to support cancellation — aborting kills the child process.
 */
export function run(
  cmd: string,
  args: string[],
  opts: { onLine?: LineSink; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { signal: opts.signal });
    let stderrTail = "";

    const pump = (stream: "out" | "err") => (buf: Buffer) => {
      const text = buf.toString();
      if (stream === "err") stderrTail = (stderrTail + text).slice(-2000);
      if (!opts.onLine) return;
      for (const line of text.split(/\r?\n|\r/)) {
        if (line.trim()) opts.onLine(line, stream);
      }
    };

    child.stdout?.on("data", pump("out"));
    child.stderr?.on("data", pump("err"));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${cmd} exited with code ${code}` +
                (stderrTail.trim() ? `:\n${stderrTail.trim()}` : ""),
            ),
          ),
    );
  });
}
