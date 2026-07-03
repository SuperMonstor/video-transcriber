# Bundled binaries

The packaged app ships self-contained `whisper-cli` and `ffmpeg`/`ffprobe` so
users don't need Homebrew or any install. electron-builder copies these into
`Contents/Resources/bin` (mac) / `resources/bin` (win), where
`src/main/binaries.ts` finds them at runtime. The model itself is **not** here —
it downloads on first run (see `src/main/model-manager.ts`).

These binaries are large and platform-specific, so they are **git-ignored** and
staged before a packaging build:

```
resources/bin/mac/    whisper-cli  ggml*.dylib  ffmpeg  ffprobe   (arm64)
resources/bin/win/    whisper-cli.exe  *.dll     ffmpeg.exe  ffprobe.exe   (x64)
```

Optional speaker detection also looks for:

```
resources/bin/mac/    sherpa-onnx-offline-speaker-diarization
resources/bin/win/    sherpa-onnx-offline-speaker-diarization.exe
```

The sherpa ONNX model files are resolved from the app model directory, not from
`resources/bin`:

```
models/sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx
models/nemo_en_titanet_small.onnx
```

For local development, override these with `SHERPA_ONNX_DIARIZE`,
`SHERPA_ONNX_SEGMENTATION_MODEL`, and `SHERPA_ONNX_EMBEDDING_MODEL`.

## Sourcing notes

- **ffmpeg / ffprobe** — use fully static builds (no dylib/DLL dependencies):
  - mac arm64: e.g. evermeet.cx or osxexperts static builds
  - win x64: e.g. gyan.dev "essentials" static build
- **whisper-cli** — Homebrew's binary is dynamically linked against
  `/opt/homebrew/lib`, so it is **not** portable as-is. For the mac bundle the
  required `libwhisper`/`libggml*` dylibs must be collected alongside it and the
  rpath fixed (`install_name_tool` / `dylibbundler`), or whisper.cpp built
  statically. For Windows, use the official whisper.cpp release zip
  (`whisper-cli.exe` + DLLs) — CPU build for first cut, cuBLAS build to use the
  GTX 1650's GPU.
- **sherpa-onnx diarization** — use the prebuilt
  `sherpa-onnx-offline-speaker-diarization` CLI for each platform, plus the
  `sherpa-onnx-pyannote-segmentation-3-0` int8 segmentation model and
  `nemo_en_titanet_small.onnx` speaker embedding model. Diarization is optional:
  if the binary or either model is missing, the app falls back to normal
  transcription.

A `scripts/stage-binaries` helper will automate this once the sourcing approach
is chosen (see ARCHITECTURE.md §10 / packaging decision).
