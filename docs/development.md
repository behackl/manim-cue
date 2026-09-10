# Development and validation

## Launch without installing a VSIX

```sh
pnpm install
pnpm build
code --new-window --extensionDevelopmentPath="$PWD" "$PWD/examples"
```

Or open this repository in VS Code and press **F5**. Select the interpreter in the
Extension Development Host before opening a Scene.

## Checks

```sh
pnpm check
pnpm test
pnpm test:python                   # stdlib parser + canonical verification (via uv)
MANIM_PYTHON=/path/to/python pnpm test:integration
pnpm test:ui                       # installed Google Chrome via playwright-core
MANIM_PYTHON=/path/to/python pnpm test:vscode
pnpm test:vscode:activation        # editor API smoke, no Manim required
pnpm package                      # creates a local VSIX; does not publish
```

By default the VS Code tests use isolated user data and a copy of the locally installed
Microsoft Python extension. `VSCODE_EXECUTABLE` can select another desktop VS Code.
For self-contained inputs, set `VSCODE_VERSION` (instead of `VSCODE_EXECUTABLE`) and
`PYTHON_EXTENSION_VERSION`. This explicitly downloads Code and installs the specified Python
extension into the temporary test profile, never the normal profile. Test-profile telemetry
and extension updates are disabled. For example:

```sh
VSCODE_VERSION=1.96.0 PYTHON_EXTENSION_VERSION=2024.22.2 pnpm test:vscode:activation
```

The activation-only smoke checks manifest identity, command registration, idle activation,
basic lifecycle commands, and actual artifact copies with wide/tall preview profiles.
It does **not** prove rendering or Python API integration.
The full native smoke exercises CodeLens, the real timeline/preview pipeline, decoded video presentation,
stale-state gating, save-triggered refresh, superseding saves, failure recovery and
cancellation, timestamp restoration/clamping and cache clearing. Unit/UI tests consume
the public v1 fixture and a small generated seek-test movie, and do not require Manim.
Measurement UI checks cover letterboxing, resizing at device scale 2, Y orientation,
copy requests, stills, missing dimensions and stale/replacement media. Comparison browser
checks cover wipe/opacity pixels, keyboard/drag controls, high-DPI resizing, stale/current
and reference decode races, view reconstruction, and entry from a playing movie. The
native smoke also checks explicit movie-frame capture, pending-pin cancellation, reference
retention across saves/profile changes, movie suppression and Scene-switch cleanup.
Export checks cover codec-option validation, atomic file publication, serial-process holds,
responsive dialog/focus behavior, artifact copies across a pending Save As, capture from a
movie, independent rendering, encoder errors, cancellation/source invalidation and dirty
source save consent. Copies remain independent of invalid hidden render defaults; frame-only
previews can step without enabling playback or inventing a duration. Real renders verify
resolution/FPS/audio and configuration isolation.
Integration tests explicitly require the supported environment.

## CI coverage

`.github/workflows/ci.yml` is configured for:
- Type checking, TS units, stdlib-only Python tests and bundles on Linux, macOS and Windows.
- Chrome UI tests on Linux, including the real H.264 seek fixture and preference restoration.
- Isolated extension activation on Linux with VS Code **1.96.0** and **stable**, using Microsoft
  Python **2024.22.2** (whose editor requirement includes 1.96).
- A Linux VSIX packaging check to a temporary path; nothing is published or installed normally.
- Native integrations and the full desktop smoke on Linux with Python 3.13 and stable Code.
  A fresh environment installs Manim from upstream `refactor/manager-targeted-frame`, with
  Cairo/Pango, fonts, audio/video libraries and Xvfb provisioned for the fixtures.

The native job deliberately follows the **branch**, not a fixed SHA, to detect upstream
regressions. It refreshes Git dependency resolution, records the installed commit in the job
summary, logs dependency versions, and checks all required APIs before running the suites.
Runs happen on pushes/PRs, manual **Run workflow**, and daily at 05:23 UTC. An upstream branch
push does not itself trigger this repository; the scheduled/manual runs cover that gap.
Use the logged commit when reproducing a failure or deciding which build to recommend.

The new native job still needs its first successful hosted run. Passing helper or activation
jobs alone does not establish Windows native-process-tree cancellation, codec behavior or a
complete editor/platform rendering matrix. Node 24 is CI tooling; the extension bundle targets
Node 20 and the declared minimum VS Code API types.

The intended public channel is the official VS Code Marketplace under publisher **behackl**.
Packaging and publishing are separate actions; choose a new release version and validate the
exact VSIX before an explicitly approved publication. `pnpm package` does not publish.

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for the public Manim fixture and bundled Python-extension
API helper attribution. The generated demo WAV is original to this project.
