# How scene updates work

Manim Cue runs your saved scene in separate steps so it can show useful results early.
Understanding those steps helps explain the status labels in the preview.

## Update order

When you open or refresh a Scene, Cue:

1. captures the frame at your selected time;
2. evaluates the scene to build the timeline;
3. renders a complete preview video when **Auto video** is enabled.

Each step runs the scene in a fresh Python process, so every step starts clean and can
be cancelled independently. It also means scenes that
use randomness, the current time, network responses, or changing files can produce
different content between the captured frame and rendered video.

Cue runs one Manim process at a time. A requested frame takes priority over background
video work. While an export runs, preview updates wait for it to finish or be cancelled.

## Saved files and refreshes

Cue works from saved local Python files. Saving the main scene file schedules an update
after a short pause, including saves made by VS Code Auto Save. Unsaved edits stop the
active update and mark the visible result as old.

Changes to imported Python files, assets, `manim.cfg`, or the selected environment need
a manual **Refresh**. This keeps a helper-file save from unexpectedly executing a scene.

The working directory is the workspace folder by default, or the source file's parent
for a loose file. Change **Manim Cue: Working Directory** when your imports or relative
asset paths expect another directory.

## Preview profile

The default preview uses Cairo at 30 frames per second and about 960 pixels wide. Change
**Frame Rate** and **Preview Width** in VS Code Settings. Cue keeps the aspect ratio from
your Manim configuration.

Frame rate affects how Manim evaluates animations and updaters, so changing it can alter
the timeline as well as the video. Cue uses seed `0` when the project has no configured
seed, which makes many scenes more repeatable while editing.

Cue reads your project configuration and applies preview-specific output settings. It
writes generated media and caches to the extension's storage area rather than editing
your project configuration.

## Current, old, and unlinked results

A result is **current** when it matches the saved scene, selected environment, preview
settings, and known configuration inputs.

An **OLD PREVIEW** remains visible while an update is running or after an input changes.
Keeping it visible makes it easier to compare your edit with the previous result.

Frame, timeline, and video updates can finish separately. If one succeeds and a later
step fails, Cue keeps the useful result and labels combinations that came from different
runs as **UNLINKED**. Press **Refresh** after fixing the error.

## Files, caches, and trust

Temporary previews, timeline data, and caches live in VS Code extension storage. Run
**Manim Cue: Clear Caches** when you change fonts or typesetting tools, or when you want
to reclaim cache space. Exported files are written only after rendering finishes, so a
failed export leaves an existing destination intact.

A Manim scene runs as normal Python code. It has the same access to files, the network,
and other processes as Python started from your account. Cue therefore requires a
trusted workspace before discovering or running scenes.
