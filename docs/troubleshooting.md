# Python and troubleshooting

## Check the environment first

Run **Manim Cue: Check Python Environment** from the Command Palette. The notification
shows one result:

- **Ready.** Cue can show frames, timelines and videos, and export videos.
- **Manim is not installed in this Python environment.** Run
  **Manim Cue: Set Up Python Environment**, or select another environment.
- **Manim does not start in this Python environment.** The log shows the error, for
  example a missing system library.
- **This Manim version does not have the features Cue needs.** Run
  **Manim Cue: Set Up Python Environment** to install the supported version.

The log (**Manim Cue: Show Log**) shows the details: the Python executable, the Python
and Manim versions, the working folder and the missing features. When an update fails,
the error under the timeline has a **Show Log** button. When the error comes from the
Python environment, it also has a **Check Python** button.

## Select the Python environment

Cue uses the interpreter that **Python: Select Interpreter** selects for the scene file.
In a workspace with more folders, each folder can use its own environment.

To use another interpreter for Cue only, run **Manim Cue: Select Python**. Select a
known environment, enter the path of a Python executable, or go back to the interpreter
of the Python extension. Then press **↻ Refresh**.

When you enter the path of a virtual environment, use the executable in the environment:

- macOS and Linux: `/path/to/project/.venv/bin/python`
- Windows: `C:\path\to\project\.venv\Scripts\python.exe`

The packages of the environment are available only through this executable.

## Set up an environment

**Manim Cue: Set Up Python Environment** creates a new `.venv` in the workspace folder of
the scene and installs Manim from the `refactor/audio-mixer` branch:

1. Choose **Create with uv** (when `uv` is on VS Code's `PATH`), **Create with the
   selected Python**, or **Locate uv…**.
2. Read the confirmation: it shows the project, the environment, the tool and the Manim
   branch. With `uv`, the setup downloads Python 3.13 if it is missing.
3. When the check of the new environment says Ready, Cue selects the environment.

If a `.venv` folder exists already, select it with **Select Python…**, or delete it to
create a new one. If the setup fails, click **Show Log** for the complete output, then
**Retry** or **Delete Incomplete .venv**. Install compilers and system libraries with the
package manager of your system.

To install the branch into an existing environment, use the commands in the
[README](../README.md#get-started). To install the newest state of the branch again,
activate the environment and run:

```sh
pip install --upgrade --force-reinstall --no-cache-dir "manim @ https://github.com/ManimCommunity/manim/archive/refs/heads/refactor/audio-mixer.zip"
```

Then run **Manim Cue: Check Python Environment**. The log shows the path of the Manim
that Python loads.

## The preview stays Outdated

The label **OUTDATED** means that the shown frame comes from an earlier version of the
scene or from other settings.

1. Save the scene file.
2. Press **↻ Refresh** in the timeline.
3. Read the error under the timeline and open **Manim Cue: Show Log**.
4. Run **Manim Cue: Check Python Environment** if imports or packages changed.

A save of the scene file starts an update. After a change to an imported file,
`manim.cfg`, an asset or the Python environment, press **↻ Refresh**.

## Imports or assets are not found

Cue runs the scene in its workspace folder. For a Python file outside a workspace, it
uses the folder of the file.

If your project needs another working folder, set **Manim Cue: Working Directory** in the
VS Code settings. The value is a full path or a path relative to the workspace folder.

Also make sure that:

- the selected environment contains each imported package;
- the asset paths work from the working folder;
- the scene runs with the same environment in a terminal.

## The frame, the timeline or the video fails

The error under the timeline names the failure. **Manim Cue: Show Log** shows the complete
output of Manim and the Python executable.

Common fixes:

- install the system packages of Manim for Cairo, Pango and FFmpeg;
- install the fonts or the TeX tools of the scene;
- increase **Manim Cue: Timeout Seconds** for a slow scene;
- run **Manim Cue: Clear Caches** after a change to fonts or typesetting tools;
- reduce **Manim Cue: Preview Width** while you edit a large scene.

For export errors, make sure that width and height are even and in the limits of the
dialog. Encoder options use one `key=value` pair on each line.

## Report a problem

Include:

- the log of **Manim Cue: Check Python Environment**;
- the part of **Manim Cue: Show Log** with the error;
- your operating system and VS Code version;
- a small scene that shows the problem, if possible.

The Manim path in the log helps more than the version number of Manim.
