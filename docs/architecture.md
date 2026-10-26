# How an update works

Manim Cue runs your saved scene in Python and shows the results in steps, so that you
see a frame early. This page explains the steps and the status line of the preview.

## Update order

When you open a scene or save its file, Cue:

1. runs the scene once and shows the frame at the selected time as soon as the scene
   reaches that time;
2. shows the timeline when the same run ends;
3. renders the video when **Auto Preview** is on. The render also makes the timeline
   of the video, and the timeline view shows that timeline.

Each run starts a new Python process, so each run starts clean and you can cancel it.
Scenes that use random numbers, the current time, the network or files that change
can give a video that differs from the frame.

When you choose another time and there is no video yet, Cue runs the scene up to that
time and shows its frame. This run stops after the frame.

Cue runs one Python process at a time. A frame for a new time comes before the video.
During an export, preview updates wait until the export is done or cancelled.

## Saved files and refreshes

Cue runs the saved scene file. When you save the scene file, Cue starts an update after
a short pause, also for saves from VS Code Auto Save. When you edit the file without
saving it, the results become **Outdated**.

After a change to an imported Python file, an asset, `manim.cfg` or the Python
environment, press **↻ Refresh**.

The scene runs in the workspace folder, or in the folder of the scene file outside a
workspace. To use another folder, set **Manim Cue: Working Directory**.

## Preview settings

The preview uses Cairo, 30 frames per second and a width of about 960 pixels. Change
**Frame Rate** and **Preview Width** in the VS Code settings. The height follows the
aspect ratio of your Manim configuration.

Animations and updaters run at the frame rate of the preview, so a different frame rate
can change the timeline and the video. Cue uses the seed `0` when your project sets no
seed, so random numbers repeat from one update to the next.

Cue reads your project configuration and writes its own preview settings, media and
caches into the storage of the extension.

## Outdated results

The frame, the timeline and the video are each up to date or **Outdated**. A result is
Outdated when the scene file, the Python environment or a setting changed after the
result started. An Outdated result stays visible until the new result is ready, so you
can compare your change with the previous result.

## Skipped sections

A section with `skip_animations=True` is not in the video. The timeline shows all plays
and waits at their scene times, and marks the skipped ones with a hatch. The playhead,
the scrubber, frame steps and loops use scene time. When you select a time in a skipped
section, Cue shows the frame from a run of the scene and the note "This part is skipped
in the video." Playback goes over skipped sections without a stop.

## Sounds

The timeline shows each sound at the scene time where it starts. A sound with a known
duration is a bar. The preview plays without sound; an exported video contains the
sounds of the scene.

## Files, caches and trust

Previews, timelines and caches are in the storage of the extension. Run
**Manim Cue: Clear Caches** after you change fonts or typesetting tools, or to free
space. An export writes its file when the render is complete, so a failed export keeps
an existing file.

Your scene runs as normal Python code with your account's access to files, the network
and other programs. Cue runs scenes in trusted workspaces.
