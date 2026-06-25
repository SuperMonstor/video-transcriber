/**
 * Stage native binaries into resources/bin/<platform> before an electron-builder
 * packaging build. Downloads release archives, extracts the needed executables +
 * libraries, and flattens them into the bundle's bin dir.
 *
 *   node scripts/stage-binaries.mjs win
 *   node scripts/stage-binaries.mjs mac
 *
 * URLs/manifests are filled in from verified research (see MANIFEST below).
 */
import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);
// fileURLToPath (not .pathname) — on Windows .pathname gives "/C:/..." which
// breaks path joins.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Per-platform list of archives to fetch and which files to pull out.
 * `pick` is a list of basenames (case-insensitive) to copy into bin/.
 * `pickExt` copies every file with one of those extensions (e.g. dll).
 * Filled from the binary research — left empty here until verified.
 */
const MANIFEST = {
  win: [
    {
      // whisper.cpp v1.9.1 CUDA 12.4 build — self-contained (bundles cudart/
      // cublas/cublasLt DLLs). Runs on the GTX 1650 (Turing 7.5) with just an
      // NVIDIA driver. whisper-cli.exe + every DLL (incl. all ggml-cpu variants).
      url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-cublas-12.4.0-bin-x64.zip",
      pick: ["whisper-cli.exe"],
      pickExt: ["dll"],
    },
    {
      // BtbN static (non-shared) ffmpeg — no external DLLs. Pinned to the 7.1 line.
      url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-7.1.zip",
      pick: ["ffmpeg.exe", "ffprobe.exe"],
    },
  ],
  mac: [
    // mac needs dylib relocation for whisper-cli; handled separately.
  ],
};

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function extractZip(zipPath, outDir) {
  // bsdtar (macOS + Windows `tar`) extracts .zip; avoids depending on `unzip`,
  // which isn't guaranteed on Windows CI runners.
  await pExecFile("tar", ["-xf", zipPath, "-C", outDir]);
}

/** Recursively find files under `dir` matching a predicate. */
async function findFiles(dir, match, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await findFiles(full, match, acc);
    else if (match(entry.name)) acc.push(full);
  }
  return acc;
}

async function stage(platform) {
  const entries = MANIFEST[platform];
  if (!entries || entries.length === 0) {
    throw new Error(
      `No binary manifest for "${platform}" yet — fill MANIFEST with verified URLs.`,
    );
  }

  const binDir = join(ROOT, "resources", "bin", platform);
  await rm(binDir, { recursive: true, force: true });
  await mkdir(binDir, { recursive: true });

  for (const entry of entries) {
    const work = await mkdtemp(join(tmpdir(), "vt-stage-"));
    const archive = join(work, basename(new URL(entry.url).pathname));
    console.log(`↓ ${entry.url}`);
    await download(entry.url, archive);
    await extractZip(archive, work);

    const want = (name) => {
      const lower = name.toLowerCase();
      if (entry.pick?.some((p) => p.toLowerCase() === lower)) return true;
      if (entry.pickExt?.some((ext) => lower.endsWith(`.${ext.toLowerCase()}`))) return true;
      return false;
    };
    const files = await findFiles(work, want);
    if (files.length === 0) console.warn(`  (nothing matched in ${basename(archive)})`);
    for (const f of files) {
      await cp(f, join(binDir, basename(f)));
      console.log(`  → bin/${platform}/${basename(f)}`);
    }
    await rm(work, { recursive: true, force: true });
  }

  console.log(`\nStaged into ${binDir}`);
  console.log(await readdir(binDir));
}

const platform = process.argv[2];
if (!["win", "mac"].includes(platform)) {
  console.error("usage: node scripts/stage-binaries.mjs <win|mac>");
  process.exit(1);
}
if (!existsSync(join(ROOT, "resources"))) {
  console.error("run from the project root");
  process.exit(1);
}
stage(platform).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
