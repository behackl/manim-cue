# Performance and caches

Cue prepares the profile and captures the selected frame in **one fresh process**.
Timeline evaluation and movie rendering use that profile in separate processes. One
Python job runs at a time; frame requests preempt background work. Capturing a late
frame runs the preceding animation and drawing steps, so its cost depends on the scene.

In **Compare**, seeks capture stills even when a compatible movie is cached; automatic
movie work is suspended. Moving the wipe divider or opacity slider only composites the
two decoded images in the webview and never invokes Python.

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

Earlier timeline-only measurements on `OpeningManim` at 30 fps/960-pixel width changed
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
