# Python and troubleshooting

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

Run **Manim Cue: Check Python Environment** from the Command Palette. Import/environment
errors also offer a **Check Python** action in the timeline pane.
The output channel shows the resource/workspace, selection rule, requested executable,
actual `sys.executable`, Python version/prefix, CWD, and Manim module path/version.
It distinguishes missing Manim, import/dependency failures, unsupported builds and
limited feature support. Timeline, frame capture and export encoder configuration are
reported separately. Failed subprocess messages also include the executable.

**Manim Cue: Select Python for Manim Cue** offers the Python extension's known workspace
environments, an explicit executable path, or following the Python extension's selection.
It confirms the settings scope before writing a Cue-only override, then checks it.
For files outside workspace folders it explicitly explains the broader workspace/User
scope. No environment is created, no package is installed, and the Python extension's
own interpreter selection is not changed. **Refresh** afterward to retry the Scene.

The check uses the same selected Python, environment and CWD, with isolated cold
bytecode lookup rather than the execution cache. It requests no
scene evaluation/render, but importing Manim may execute package/plugin initialization;
workspace trust is required. **Ready** means all three API checks passed, not that native
encoders, optional dependencies, LaTeX tools or scene-specific imports work. **Limited**
means at least one API is available; the output names the missing features.
Installation, guided dependency repair and managed environments remain future work.

## Manim capabilities

Ordinary PyPI Manim **0.21.0** does not have Cue's required experimental APIs. Development
builds may also report 0.21.0 while providing them; do not rely on a version comparison or
assume reinstalling that release will fix an unsupported environment. Use the preview branch
installation commands in the [README](../README.md#get-started), select that environment's
Python in VS Code, and run the check before opening a Scene.

The branch moves. A uv project's lockfile retains its resolved commit: to test a newer branch
revision, run `uv lock --upgrade-package manim`, then `uv sync`. With pip, rerun the README's
`pip install --upgrade` command; if the unchanged version string leaves the old build installed,
add `--force-reinstall`. After updating, run **Check Python Environment** and **Refresh**.
CI logs the exact commit it tested; that is more useful than `0.21.0` alone in a bug report.

| Feature | Required public API |
| --- | --- |
| Timeline, full preview and looping | `Manager.evaluate(capture_timeline=True)` and CLI `--timeline-output` with `manim.execution-timeline` v1 |
| Frame-first updates and still comparison | `Manager.capture_frame_at(timestamp)` |
| New MP4 export with independent encoding | Configuration properties `video_codec`, `pixel_format`, `video_encoder_options` |

The environment check inspects the Manager API and encoder configuration without executing
a Scene. Timeline CLI/schema compatibility and native encoding are validated when used.
A timeline-only build can still render full previews; a frame-only build can show captured
stills but has no timeline/full preview. New MP4 renders require the encoder API, not the
timeline/capture APIs. Existing artifact copies do not need a new render.
If neither timeline nor capture is available, Cue stops queued work and offers environment
checks rather than trying to synthesize a timeline. Select a capable build, then **Refresh**.

## Moving from local builds

The Marketplace identity is `behackl.manim-cue`. If you previously installed
`manim-cue-local.manim-cue`, disable or uninstall that extension before installing the new
identity to avoid duplicate commands/CodeLens. This does not change the selected Python;
Cue's extension-private remembered state is not migrated between identities.

See [usage](usage.md) for preview controls and [performance](performance.md) for cache troubleshooting.
