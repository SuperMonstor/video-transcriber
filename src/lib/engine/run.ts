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

    // Chunks can end mid-line; hold the partial tail until the next chunk.
    const partial = { out: "", err: "" };
    const emit = (stream: "out" | "err", lines: string[]) => {
      for (const line of lines) if (line.trim()) opts.onLine?.(line, stream);
    };
    const pump = (stream: "out" | "err") => (buf: Buffer) => {
      const text = buf.toString();
      if (stream === "err") stderrTail = (stderrTail + text).slice(-2000);
      if (!opts.onLine) return;
      const lines = (partial[stream] + text).split(/\r?\n|\r/);
      partial[stream] = lines.pop() ?? "";
      emit(stream, lines);
    };

    child.stdout?.on("data", pump("out"));
    child.stderr?.on("data", pump("err"));
    child.on("error", reject);
    child.on("close", (code) => {
      emit("out", [partial.out]);
      emit("err", [partial.err]);
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${cmd} exited with code ${code}` +
                (stderrTail.trim() ? `:\n${stderrTail.trim()}` : ""),
            ),
          );
    });
  });
}
