# Using Manim Cue

## Open and update a scene

Open a saved Python file and click **▶ Open Manim Cue** above a Manim `Scene` class. You
can also run **Manim Cue: Open Scene** from the Command Palette.

When you save the file, Cue updates:

1. the frame at the selected time;
2. the timeline;
3. the video, when **Render Video Automatically** is on.

The previous frame stays visible with the label **OUTDATED** while Cue works. When you
edit the file again or press **■ Cancel**, the running update stops. Press **↻ Refresh**
after a change to an imported file, a configuration file, an asset or the Python
environment.

Cue keeps the last scene and the selected time of each workspace. Another scene opens at
its start.

## Move through the scene

- Drag the scrubber to choose a time.
- Press **Play** or **Pause**, or **Space** in the preview.
- Press **Left** or **Right** in the preview to step one frame.
- When **Render Video Automatically** is off, click **Render video** to make the video.
- Click **Settings** (the cog) to change the preview width, the frame rate and
  **Render Video Automatically**.

With a video, a new time shows the frame from the video. Without a video, Cue runs the
scene up to that time and shows its frame. The time display shows the time of the frame
and the duration of the scene.

The preview plays without sound. The timeline shows the sounds, and an exported video
contains them.

## Read the timeline

The timeline shows the scene in scene time. It has four lanes:

- **Sections** show where each section starts.
- **Plays & waits** show each `play()` and `wait()` call as a bar from its start to its end.
- **Captions** show each caption for the time that it is visible.
- **Sounds** show where each sound starts. A sound with a known duration is a bar.

The legend below the timeline names the styles: a play, a wait, a still image (a wait
that shows one frame) and a play that is not in the video because its section is
skipped.

Click an entry to see it in the panel on the right:

- a play or a wait: its time range, the requested run time if it is different, the
  animations, and notes such as **Still image** or **Not in the video (skipped section)**;
- a section: its name, its start time and **Skipped in the video** if it is skipped;
- a caption: its text and its time range;
- a sound: its file name, its time range or start, and its gain if the scene sets one.

Each entry shows its source line, for example `scene.py, line 12`. Double-click an
entry, or click **Go to source**, to open that line. Use the zoom buttons and the
scrollbar for a long scene. When the timeline has the focus, **Left** and **Right**
select the previous or the next play or wait.

If the scene ends early (Manim's `EndSceneEarlyException`), the header shows "The scene
ended early."

### Select and loop plays

1. Click a play or a wait to select it.
2. Cmd-click on macOS, or Ctrl-click on other systems, to add or remove one.
3. Shift-click to select a range.
4. Turn on **Loop selection** and press **Play**.

The shaded area shows the loop. It goes from the first to the last selected play. A loop
can include a skipped section; playback goes over it.

### Skipped sections

A section with `skip_animations=True` is not in the video. The timeline still shows its
plays at their scene times. When you select a time in a skipped section, Cue shows the
frame from a run of the scene and the note "This part is skipped in the video."

## Export a frame, the video or the timeline

Click **Export…** above the preview. The dialog uses the preview and the time when you
opened it. If the preview changes while the dialog is open, click **Use the latest
preview**.

- **Frame → Save PNG…** saves the frame at the selected time. When the preview shows the
  video, Cue runs the scene to make this frame at the preview size.
- **Video → Save the preview video** saves a copy of the preview video.
- **Video → Render a new video** renders the whole scene with the settings of the dialog.
- **Timeline → Save JSON…** saves the timeline in the `manim.timeline` format.

A scene without plays and waits has no video. For such a scene, the dialog offers the
frame and the timeline.

A new video is an MP4 file with H.264. Choose a size, or enter a width and a height.
Width and height must be even numbers from 64 to 8192, with at most 32 megapixels. Set
the frame rate, the quality (CRF) and the encoding effort. A lower CRF gives a higher
quality and a larger file. Under **Advanced**, you can add encoder options, one
`key=value` pair on each line.

A new video always contains the whole scene. A different frame rate runs the animations
again at that rate.

One export runs at a time. To stop it, click **Cancel export** or use the progress
notification. After the export, click **Reveal file** or **Open file**.

## Compare two frames

Click **Compare** to keep the shown frame as the reference. Edit and save the scene; the
reference stays the same while the current frame updates.

- **Wipe** shows the reference on the left and the current frame on the right. Drag the
  divider to move the edge.
- **Overlay** blends the two frames. Move the slider from the reference to the current
  frame.
- **Replace reference** uses the shown frame as the new reference.

In Compare, a new time shows a new frame from a run of the scene. **Play** ends Compare
and plays the video. When you open another scene or close the preview, the reference is
removed.

## Measure coordinates and distances

Click **Measure** to show rulers and a crosshair on the preview.

- Move the pointer to read `(x, y)` in scene units.
- Click to pin a point.
- Drag from the pinned point to measure the horizontal, the vertical and the direct
  distance.
- Click **Copy point** to copy `[x, y, 0]`.
- Click **Clear**, or press Escape in the preview, to remove the points.

Measurement uses the frame size of your Manim configuration. It fits a centred 2D camera
without rotation.
