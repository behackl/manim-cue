# Python and troubleshooting

## Start with the environment check

Run **Manim Cue: Check Python Environment** from the Command Palette. It reports the
Python executable, Python and Manim versions, project folder, and available Cue features.
Errors in the timeline also offer a **Check Python** action.

A **Ready** result means Cue found support for frame capture, the timeline, and MP4
export. A **Limited** result lists the available features. Use **Manim Cue: Show Logs**
for the full command output when a scene fails.

## Choose the right Python environment

By default, Cue uses the interpreter selected by **Python: Select Interpreter** for the
current scene file. This matters in multi-folder workspaces, where each folder can use a
different environment.

To choose a Cue-specific interpreter, run **Manim Cue: Select Python for Manim Cue**.
You can select a known environment, enter a Python executable, or return to the Python
extension's selection. Run **Refresh** after changing it.

If you enter a virtual-environment path manually, use the environment's own executable:

- macOS/Linux: `/path/to/project/.venv/bin/python`
- Windows: `C:\path\to\project\.venv\Scripts\python.exe`

Avoid replacing that path with the base Python executable, because packages installed
in the virtual environment may then be missing.

## Install or update the Manim preview branch

Follow the installation commands in the [README](../README.md#get-started). The regular
PyPI Manim 0.21.0 package lacks the features Cue needs, while the preview branch may use
the same version number.

For a uv project, update to the branch's latest commit with:

```sh
uv lock --upgrade-package manim
uv sync
```

For a pip environment, activate it and rerun:

```sh
pip install --upgrade --force-reinstall "manim @ git+https://github.com/ManimCommunity/manim.git@refactor/manager-targeted-frame"
```

Then select that environment in VS Code and run **Manim Cue: Check Python Environment**.
The diagnostic output includes the loaded Manim path, which helps confirm which copy is
being used.

## The preview stays old

An **OLD PREVIEW** label means the visible image came from an earlier saved version or
rendering profile.

Try these steps:

1. Save the main scene file.
2. Press **Refresh** in the timeline toolbar.
3. Check the timeline for an error and open **Manim Cue: Show Logs**.
4. Run **Manim Cue: Check Python Environment** if imports or dependencies changed.

Automatic refresh watches the main scene file. After editing an imported helper,
`manim.cfg`, an asset, or the Python environment, press **Refresh** yourself.

A timeline and video can occasionally show **UNLINKED** after one part of an update
fails. Refreshing starts a complete update with the latest saved inputs.

## Imports or assets cannot be found

Cue normally runs the scene from its workspace folder. For a Python file outside a
workspace, it uses the file's parent folder.

If your project expects another current directory, set **Manim Cue: Working Directory**
in VS Code Settings. The value can be an absolute path or a path relative to the
workspace folder.

Also confirm that:

- the selected environment contains every imported package;
- asset paths work from the chosen working directory;
- the scene runs from the same environment in a terminal.

## Rendering, text, or video fails

Open **Manim Cue: Show Logs** first; it includes Manim's error output and the Python
executable that was used.

Common fixes include:

- install Manim's system dependencies for Cairo, Pango, and FFmpeg;
- install the fonts or TeX tools used by the scene;
- increase **Manim Cue: Timeout Seconds** for a slow scene;
- run **Manim Cue: Clear Caches** after changing fonts or typesetting tools;
- reduce **Manim Cue: Preview Width** while editing a heavy scene.

For export errors, check that custom dimensions are even and within the limits shown in
the dialog. Advanced encoder settings use one `key=value` entry per line.

## Duplicate Manim Cue commands appear

Early local builds used the extension identity `manim-cue-local.manim-cue`. Disable or
uninstall that build before installing `behackl.manim-cue`, then reload VS Code.

## Report a useful problem

Include these details when asking for help:

- the output from **Manim Cue: Check Python Environment**;
- the relevant part of **Manim Cue: Show Logs**;
- your operating system and VS Code version;
- a small scene that reproduces the problem, when possible.

The Manim path and revision are more useful than the displayed `0.21.0` version alone.
