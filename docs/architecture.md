# Execution and freshness

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
- Successive saves supersede obsolete runs. The selected frame appears first, followed
  by the timeline and optional movie. Source and position changes take priority over
  background work. Previous results stay visible with their freshness status; failures
  appear in the panel instead of modal dialogs.
- Possible Python/config dependency changes and environment/profile changes also mark
  results stale and cancel work, but require **manual refresh**: automatic refresh is
  scoped to the active primary scene file, not every Python file in the workspace.
  Failed preview generation can leave a new valid timeline and an old preview, but
  they remain visibly **unlinked**.
- Explicit exports use independent render profiles and hold the serial native-process
  slot after background preview abort/join. Seeks coalesce without preempting an export;
  source/config changes invalidate native exports, while exact artifact copies remain
  independent of later edits. Dialog/active-export file ownership survives preview
  replacement, with destination-side temporary copies published only on success.
- One active scene session; fresh processes, bounded cancellation/timeout, no daemon or
  renderer reuse. Default timeout is 600 seconds per process.
- Scratch data lives in VS Code extension storage. The displayed preview and its pending
  replacement stay available until the webview acknowledges the swap. Pinned comparison
  references have independent ownership; their files survive current-preview replacement
  and source changes. Superseded reference files are retained through reference decode
  acknowledgement, with only the displayed and latest candidate references kept.
  Abandoned media and run directories are cleaned after jobs settle. Resource roots stay
  stable; only completed media, not source/profile/cache files, is exposed to the webview.

This is **not a sandbox**. Trusted scene code and plugins can execute arbitrary Python,
access the network, write files or start other processes. Cancellation cannot undo those
side effects. Reports do not fingerprint every import, asset or external input.

## Supported scope

Cairo-first, desktop/local files, read-only timeline. Explicit GPU/image/writer requests
during evaluation are unsupported by the current core. No nested animation schedule,
mobject inspector, waveforms, audible playback, unsaved-buffer execution, automatic
source remapping, or exact event/frame mapping.

Tested on macOS with VS Code 1.135 and Chrome. Windows tree termination and remote/web
workspaces are not validated support claims. Large or unusual timelines may hit the
explicit viewer limit (16 MiB; 20,000 events/declarations). Errors retain prior data and
are available in **Manim Cue: Show Logs**. Logs also include wall-clock phase timings
for capture, evaluation, verification, movie rendering, and browser frame load/swap.
