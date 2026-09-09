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
It distinguishes missing Manim, import/dependency failures, and builds without the
required timeline API. Failed subprocess messages also include the executable.

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

See [usage](usage.md) for preview controls and [performance](performance.md) for cache troubleshooting.
