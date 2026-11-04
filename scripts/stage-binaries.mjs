/**
 * Stage native binaries into resources/bin/<platform> before an electron-builder
 * packaging build.
 *
 *   node scripts/stage-binaries.mjs win   # download whisper.cpp CUDA + ffmpeg zips
 *   node scripts/stage-binaries.mjs mac   # relocate Homebrew binaries to be portable
 *
 * Windows uses prebuilt self-contained release zips (MANIFEST). macOS has no
 * equivalent — Homebrew binaries are dynamically linked, so we copy them and use
 * dylibbundler to vendor their dylibs next to the binary (@executable_path/libs).
 * CI installs the Homebrew formulae + dylibbundler before calling this.
 */
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// fileURLToPath (not .pathname) — on Windows .pathname gives "/C:/..." which
// breaks path joins.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Windows: archives to fetch and which files to extract (flattened into bin/). */
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
    {
      // sherpa-onnx speaker diarization runtime. Shared no-TTS build keeps the
      // payload small; copy the diarization CLI plus runtime DLLs beside it.
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.3/sherpa-onnx-v1.13.3-win-x64-shared-MD-Release-no-tts.tar.bz2",
      pick: [
        "sherpa-onnx-offline-speaker-diarization.exe",
        "onnxruntime.dll",
        "onnxruntime_providers_shared.dll",
      ],
    },
  ],
};

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

// On Windows, call the OS-bundled bsdtar by absolute path: a bare `tar` can
// resolve to GNU tar (Git Bash / MSYS), which can't extract .zip and parses
// `C:\...` as a remote `host:path`.
const TAR =
  process.platform === "win32" &&
  existsSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"))
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";

async function extractZip(zipPath, outDir) {
  // bsdtar (macOS + Windows `tar`) extracts .zip/.tar.bz2; avoids depending on `unzip`,
  // which isn't guaranteed on Windows CI runners.
  execFileSync(TAR, ["-xf", zipPath, "-C", outDir]);
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

async function stageFromManifest(platform, binDir) {
  const entries = MANIFEST[platform];
  if (!entries || entries.length === 0) {
    throw new Error(`No binary manifest for "${platform}".`);
  }
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
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const realPathOf = (bin) => sh("readlink", ["-f", sh("which", [bin])]);

/**
 * macOS: copy whisper-cli/ffmpeg/ffprobe and vendor their dylibs into bin/mac/libs
 * with @executable_path/libs paths, so the bundle runs without Homebrew. Requires
 * whisper-cli, ffmpeg, ffprobe, and dylibbundler on PATH (CI brew-installs them).
 */
async function stageMac(binDir) {
  await rm(binDir, { recursive: true, force: true });
  await mkdir(join(binDir, "libs"), { recursive: true });

  const brewLib = join(sh("brew", ["--prefix"]), "lib");

  for (const name of ["whisper-cli", "ffmpeg", "ffprobe"]) {
    const real = realPathOf(name);
    const dest = join(binDir, name);
    await cp(real, dest);
    // whisper-cli resolves its dylibs via @loader_path/../lib (sibling of bin/);
    // ffmpeg/ffprobe via the Homebrew lib dir. Pass both as search paths.
    const searchPaths = [join(dirname(real), "..", "lib"), brewLib];
    execFileSync(
      "dylibbundler",
      [
        "-of", "-cd", "-b",
        "-x", dest,
        "-d", join(binDir, "libs"),
        "-p", "@executable_path/libs/",
        ...searchPaths.flatMap((p) => ["-s", p]),
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    console.log(`  → bin/mac/${name} (+ vendored dylibs)`);
  }

  const work = await mkdtemp(join(tmpdir(), "vt-sherpa-"));
  const archive = join(work, "sherpa-onnx-osx-arm64-shared-no-tts.tar.bz2");
  const url =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.3/sherpa-onnx-v1.13.3-osx-arm64-shared-no-tts.tar.bz2";
  console.log(`↓ ${url}`);
  await download(url, archive);
  await extractZip(archive, work);

  const sherpaFiles = await findFiles(
    work,
    (name) =>
      name === "sherpa-onnx-offline-speaker-diarization" ||
      name === "libonnxruntime.1.24.4.dylib" ||
      name === "libonnxruntime.dylib",
  );
  for (const f of sherpaFiles) {
    await cp(f, join(binDir, basename(f)));
    console.log(`  → bin/mac/${basename(f)}`);
  }
  await rm(work, { recursive: true, force: true });
}

const platform = process.argv[2];
if (!["win", "mac"].includes(platform)) {
  console.error("usage: node scripts/stage-binaries.mjs <win|mac>");
  process.exit(1);
}

const binDir = join(ROOT, "resources", "bin", platform);
const run = platform === "mac" ? stageMac(binDir) : stageFromManifest(platform, binDir);
run
  .then(async () => {
    console.log(`\nStaged into ${binDir}`);
    console.log(await readdir(binDir));
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
