# Manim Cue — experimental preview

A runtime timeline for normal Manim Python scenes. Click **▶ Open Manim Cue** above a
Scene class to open a bottom timeline and a preview beside your editor.

**The timeline is the primary result.** It displays observed play/wait spans, sections,
caption intervals, and sound cues from Manim's completed no-raster evaluation. It does
not estimate timing from Python source or animation run-time arguments.

## Try it

Requirements: desktop VS Code 1.96+, the Microsoft Python extension, and a Python
environment containing the **experimental Manim timeline-export implementation**.
This version was tested against Manim commit `a57eaaff`; a normal PyPI installation
without `Manager.evaluate(capture_timeline=True)` is not sufficient.

1. Install the locally built VSIX: **Extensions → … → Install from VSIX…**, choosing
   `manim-cue-0.1.5.vsix`. Or run:
   ```sh
   code --install-extension ./manim-cue-0.1.5.vsix
   ```
2. Open your scene folder in a **trusted** VS Code window.
3. Use **Python: Select Interpreter** to select the environment with the new Manim build.
   Alternatively set `manimCue.pythonPath` to its absolute Python executable.
4. Open `examples/cue_demo.py` and click **Open Manim Cue** above `CueDemo`.
   The **Manim Cue: Open Scene** command also works, including a manual class-name fallback.

For an editable Manim checkout, select that checkout's virtual-environment Python
(e.g. `/path/to/manim/.venv/bin/python`). Interpreter paths belong in the setting above,
not in your Python source. The demo includes its own short WAV sound cue.

### Without installing a VSIX

```sh
pnpm install
pnpm build
code --new-window --extensionDevelopmentPath="$PWD" "$PWD/examples"
```

Or open this repository in VS Code and press **F5**. Select the interpreter in the
Extension Development Host before opening a Scene.

## Which Python does Cue use?

1. A nonempty `manimCue.pythonPath` setting wins.
2. Otherwise Cue waits for the Python extension to initialize and asks its API for the
   selected environment **for the scene file's URI**. It does not use whichever `python`
   happens to be in your terminal PATH.

Following **Python: Select Interpreter** is the default. If you previously configured
an explicit Cue path, choose **Default: follow Python: Select Interpreter** in Cue's
picker (or set `manimCue.pythonPath` to an empty string) to restore that behavior. Cue
does not silently replace an explicit override when the status-bar interpreter changes.

Selection is resource/workspace-scoped. Another folder, multi-root workspace or loose
file can resolve differently from the interpreter shown for another editor. An explicit
Cue override can also differ from the Python status bar. Keep a virtual environment's
`.venv/bin/python` path intact; resolving its symlink to the base Python can lose the env.

Click **Python** in the timeline toolbar, or run **Manim Cue: Check Python Environment**.
The output channel shows the resource/workspace, selection rule, requested executable,
actual `sys.executable`, Python version/prefix, CWD, and Manim module path/version.
It distinguishes missing Manim, import/dependency failures, and builds without the
required timeline API. The toolbar tooltip shows the last scene interpreter; failed
subprocess messages also include the executable.

**Manim Cue: Select Python for Manim Cue** offers the Python extension's known workspace
environments, an explicit executable path, or following the Python extension's selection.
It confirms the settings scope before writing a Cue-only override, then checks it.
For files outside workspace folders it explicitly explains the broader workspace/User
scope. No environment is created, no package is installed, and the Python extension's
own interpreter selection is not changed. **Refresh** afterward to retry the Scene.

The check uses the same selected Python, environment and CWD, with isolated cold
bytecode lookup rather than the execution cache. It requests no
scene evaluation/render, but importing Manim may execute package/plugin initialization;
workspace trust is required. Success means the timeline API is available, not that every
optional dependency, LaTeX tool or scene-specific import is installed. Installation,
guided dependency repair and managed environments remain future work.

## Reading the timeline

- **Bar widths are observed execution spans.** At 4 fps an ordinary 0.3 s wait advances
  0.5 s; a frozen 0.3 s wait advances 0.25 s. The inspector keeps these separate from
  the nominal request, evaluated sample count and logical hold intervals.
- Repeated calls at the same source line remain separate events and show occurrence
  numbers. A wait is not duplicated as a second play.
- Section markers are reached declarations. A requested section skip is explicitly
  labeled: no-raster evaluation ignores it, while ordinary rendering may skip output.
- Caption bars and sound diamonds use their **placement**, which can precede the
  declaration. A sound with unknown duration is a point cue, not a made-up waveform/bar.
- Text in the timeline pane is deliberately non-selectable so scrubbing cannot select
  labels. Copy diagnostics from the **Logs** output channel instead.
- Click a bar/cue to inspect it. Double-click, or use **Go to source**, to navigate.
  Left/right select timed calls; zoom controls and horizontal scrolling inspect detail.
- The source root is the primary file's directory. Only primary source bytes are
  fingerprinted; helpers are best-effort navigation and outside-root hints are not links.
- **Export** writes the original, verified JSON, retaining its numeric representation
  and canonical revision. UI numeric labels are rounded for readability; data is not.

## Video is secondary — and honestly limited

Auto preview runs the Python scene **a second time**, with animation-segment caching
disabled, after publishing the timeline. Uncheck it for timeline-only work. Rendering is not required for a timeline.
Static scenes get a labeled PNG preview instead of a fabricated movie.

The video drives the marker through presented-frame timestamps. Click/drag the timeline
to seek; seeking pauses playback. There are **no Python jobs while scrubbing**.

Refresh preserves the selected **absolute timestamp** and pauses the old movie. The
replacement loads and seeks offscreen, then replaces the old preview only once data for
that position is decoded. It stays paused. A newer selection made during rendering wins.
Timeline-only refreshes and failed/cancelled runs also retain the position. A shorter
scene clamps it to the new end (shown in status); opening a different Scene resets it.
This is time preservation, not automatic identification of the same animation after edits.

The event/video pairing is **approximate, not verified**: timeline v1 has no encoded
frame associations. Randomness, external state, draw-dependent code or custom execution
can differ between the two runs even if their durations match. Obvious rate, duration,
section-skip or logical-gap mismatches disable linked seeking instead of stretching the
timeline. Both independent results remain inspectable.

Video checks distinguish nominal FPS from the container's average-rate metadata, which
can differ slightly due to segment/mux timestamps. Every decoded frame's presentation
time is checked against the nominal cadence; deviations exceeding half a frame disable
linking, even if the total duration matches. This does not establish event/frame
associations. No timeline or movie timestamps are rewritten or stretched. Diagnostic logs
show nominal/average rates, decoded frame count and maximum timing deviation.

Preview is deliberately **muted** in this first version. Manim's default MP4 sound uses
AAC, which VS Code webviews do not reliably support. Cue markers still work, and normal
rendering still validates/mixes sound assets. Browser-safe audio conversion is deferred.

## Measuring scene units

Click **Measure (fixed 2D)** beneath the preview to pause playback and enable top/left
rulers and a pointer crosshair. Works on videos and still images:

- Move to read `(x, y)` in Manim units, with positive Y upward.
- Click to pin a point; drag to measure `Δx`, `Δy` and straight-line distance.
- **Copy point** copies the pinned point/drag endpoint (otherwise pointer) as `[x, y, 0]`,
  rounded to six significant digits. **Clear** or Escape over the measurement surface
  clears the selection.
- Turn measurement off to restore native video controls. Timeline seeking still works.
  The mode survives webview recreation; points clear when media is replaced or becomes stale.
- Resizing and letterboxing are accounted for; black margins outside the actual content
  are not part of the measurement surface. Pointer movement never invokes Python.

**This is an explicit fixed-camera assumption, not camera tracking.** The mapping uses
that preview's **configured** frame width/height and assumes the camera is centred at
`(0, 0)`, unrotated and fixed throughout a 2D scene. Runtime camera overrides, pan/zoom,
rotation, 3D projection and custom output cropping are not tracked. Measurements are
reference coordinates in this assumed frame, not certified world coordinates or an
`Axes` object's own data coordinates. Old/loading previews have measurement disabled;
new timeline dimensions are never applied to an old video.

## Execution and freshness

- Saved local files only. After opening a Scene, saving its source automatically refreshes
  it after a 500 ms debounce (including VS Code Auto Save and external disk edits).
  Disable `manimCue.autoRefreshOnSave` to refresh manually. Unsaved edits immediately
  cancel work and mark results stale; there is no execution on each keystroke or
  buffer-to-temporary-file substitution. Cancel also clears a queued automatic refresh.
- The visible default Cue profile is **Cairo, 30 fps, approximately 960 pixels wide**.
  Adjust `manimCue.frameRate` and `manimCue.previewWidth`. FPS is used for BOTH evaluation
  and rendering: changing it changes the observed schedule, not merely video quality.
  The configured aspect ratio/camera dimensions are preserved. An unset scene seed is
  set to 0 in this profile; an existing configured seed is retained and displayed.
- CWD defaults to the workspace folder (source parent for a loose file). Override with
  `manimCue.workingDirectory` when your project's imports/assets expect another CWD.
- Project configuration is preserved with explicit Cue overrides for headless full
  execution, opaque H.264 output and private output/cache directories. Your config files
  are not edited. Existing primary bytecode caches are not reused by the launch profile.
- Successive saves supersede obsolete runs. The timeline appears first; video follows
  when Auto preview is enabled. Previous results stay visible, explicitly stale/unlinked,
  while new work runs. Automatic failures stay in the panel instead of modal dialogs.
- Possible Python/config dependency changes and environment/profile changes also mark
  results stale and cancel work, but require **manual refresh**: automatic refresh is
  scoped to the active primary scene file, not every Python file in the workspace.
  Failed preview generation can leave a new valid timeline and an old preview, but
  they remain visibly **unlinked**.
- One active scene session; fresh processes, bounded cancellation/timeout, no daemon or
  renderer reuse. Default timeout is 600 seconds per process.
- Scratch data lives in VS Code extension storage, retaining the current observation and
  prior preview. Old abandoned runs are cleaned on subsequent jobs. No workspace media
  output is intentionally produced by the extension.

This is **not a sandbox**. Trusted scene code and plugins can execute arbitrary Python,
access the network, write files or start other processes. Cancellation cannot undo those
side effects. Reports do not fingerprint every import, asset or external input.

## Faster refreshes and caches

Cue prepares the profile and invokes the public timeline CLI in **one fresh process**,
so Manim is imported once rather than twice before a timeline appears. No animation
steps, updaters or stop checks are skipped, and no Scene/interpreter state is retained.

- Private bytecode caches use **checked source hashes**, not file size/mtime. Standard
  Python source loaders revalidate bytes even for imported helpers and editable packages.
  Existing project timestamp pycs are not used. Damaged caches fall back to source.
- Manim's content-addressed text/TeX/Typst caches persist between refreshes, scoped by
  Python/environment, CWD/source directory, configuration, Cue profile and package versions.
  They follow Manim's cache semantics, not a complete external-dependency fingerprint.
- After changing system fonts, external TeX inputs or typesetting tool installations,
  use **Manim Cue: Clear Caches**, then Refresh. It cancels work, clears only Cue-owned
  caches and retains the previous observation/position as stale. Failed/cancelled
  subprocesses discard their typesetting cache to avoid reusing partial SVG output.
- Caches live in extension storage alongside run directories; use Clear Caches to reclaim
  space. A cold cache still pays import/compilation and layout costs.

On the tested `OpeningManim` scene at 30 fps/960-pixel width, timeline publication changed
from about **6.4 s** to **5.33 s cold / 1.13–1.21 s warm**, with the same timeline revision.
These measurements exclude VS Code startup/interpreter discovery and the save debounce;
other scenes may spend more time in actual user code or animation evaluation.

### Scaling measurements

Controlled timeline-only workloads on Apple M4 / Python 3.13.2, the supported Manim
branch, **30 fps / 960 px**. One fresh-cache run and three warm runs per workload;
all four revisions match within each workload. Times include preparation, evaluation
and integrity verification; exclude video rendering, VS Code startup and save debounce.

| Workload | Scene duration | Cold | Warm median |
|---|---:|---:|---:|
| 10 square shifts | 10 s | 2.70 s | 0.75 s |
| 50 square shifts | 50 s | 2.34 s | 0.79 s |
| 100 square shifts | 100 s | 2.39 s | 0.80 s |
| 50 transforms of a 100-circle group | 50 s | 3.86 s | 2.28 s |
| 50 animations, updater rebuilding 40 dots per sample | 50 s | 5.85 s | 4.31 s |
| 50 distinct LaTeX formulas faded in sequentially | 25 s | 26.32 s | 1.89 s |
| 50 frozen waits | 50 s | 2.37 s | 0.75 s |

Animation count alone is not a latency estimate: geometry/updater work and uncached
formulas dominate these differences. Frozen waits record holds instead of ordinary
interpolation samples. Cold means empty Cue caches, not a rebooted/uncached filesystem;
single cold runs have startup noise. These are controlled workloads, not a guarantee
for arbitrary complex scenes or a video-rendering benchmark.

## Current boundaries

Cairo-first, desktop/local files, read-only timeline. Explicit GPU/image/writer requests
during evaluation are unsupported by the current core. No nested animation schedule,
mobject inspector, waveforms, audible playback, unsaved-buffer execution, targeted frame
regeneration, automatic source remapping, or exact event/frame mapping.

Tested on macOS with VS Code 1.135 and Chrome. Windows tree termination and remote/web
workspaces are not validated support claims. Large or unusual timelines may hit the
explicit viewer limit (16 MiB; 20,000 events/declarations). Errors retain prior data and
are available in **Manim Cue: Show Logs**. Logs also include wall-clock phase timings
for environment preparation, evaluation, verification and preview rendering.

## Development and validation

```sh
pnpm check
pnpm test
pnpm test:python                   # stdlib parser + canonical verification (via uv)
MANIM_PYTHON=/path/to/python pnpm test:integration
pnpm test:ui                       # installed Google Chrome via playwright-core
MANIM_PYTHON=/path/to/python pnpm test:vscode
pnpm package                      # creates a local VSIX; does not publish
```

The VS Code smoke test uses isolated user data and a copy of the locally installed
Microsoft Python extension. `VSCODE_EXECUTABLE` can select another desktop VS Code.
It exercises CodeLens, the real timeline/preview pipeline, decoded video presentation,
stale-state gating, save-triggered refresh, superseding saves, failure recovery and
cancellation, timestamp restoration/clamping and cache clearing. Unit/UI tests consume
the public v1 fixture and a small generated seek-test movie, and do not require Manim.
Measurement UI checks cover letterboxing, resizing at device scale 2, Y orientation,
copy requests, stills, missing dimensions and stale/replacement media. Integration tests
explicitly require the supported environment.

See `THIRD_PARTY_NOTICES.md` for the public Manim fixture and bundled Python-extension
API helper attribution. The generated demo WAV is original to this project.
