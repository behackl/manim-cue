# Using Manim Cue

## Open and update a scene

Open a saved Python file and click **▶ Open Manim Cue** above a Manim `Scene` class.
You can also run **Manim Cue: Open Scene** from the Command Palette.

After you save the file, Cue updates in this order:

1. the frame at the selected time;
2. the execution timeline;
3. the complete preview video, when **Auto video** is enabled.

This order gives you a useful image before the full video is finished. The previous
image stays visible with an **OLD PREVIEW** label while Cue works. Editing the file again
or pressing **Cancel** stops outdated work. Use **Refresh** after changing imported
helpers, configuration files, assets, or the selected Python environment.

Cue remembers the last open Scene and selected time in each workspace. Opening another
Scene starts at its beginning.

## Navigate the preview

- Drag the scrubber to choose a time.
- Press **Play/Pause**, or press **Space** while the preview is focused.
- Press **Left/Right** while the preview is focused to step one frame.
- Use **Render video** when Auto video is off and you want a playable preview.
- Open the **settings cog** to change preview width, frame rate, and Auto video.

If a video is ready, seeking uses its rendered frames. Otherwise Cue captures a still
at the requested time. The time display shows both the current frame time and scene
duration when known.

Preview playback is muted. Sound cues appear on the timeline, and saved videos include
the scene's audio.

## Read the timeline

The timeline shows what happened while Manim executed the scene at the selected frame
rate. Each bar represents an animation or wait. Captions, sounds, and sections have
their own markers.

- Click an event to inspect it and move to its start time.
- Double-click an event, or choose **Go to source**, to open its Python line.
- Use the zoom buttons and horizontal scrollbar to inspect a busy timeline.
- Use Left/Right while the timeline is focused to move between timed events.

Repeated calls from the same source line remain separate events. Sound cues with an
unknown duration appear as points. At low frame rates, observed event boundaries can
be rounded to nearby frames.

### Select and loop a range

1. Click an event to select it.
2. Cmd-click on macOS or Ctrl-click elsewhere to add or remove events.
3. Shift-click to select a continuous range.
4. Turn on **Loop selection**, then press **Play**.

The shaded area shows the loop interval. Events between the first and last selection
are part of the interval even when their boxes are not highlighted.

## Export a frame, video, or timeline

Click **Export…** above the preview. The dialog uses the preview and selected time shown
when you opened it. Choose **Use latest preview** if a newer update finishes while the
dialog is open.

Available exports depend on the current results:

- **Current frame → Save PNG…** saves a still at the selected time. If a video is
  displayed, Cue runs the scene again to capture the frame, so scenes with changing
  external inputs or unseeded randomness may produce a different image.
- **Video → Save existing preview** copies the completed preview video.
- **Video → New render** renders the complete saved Scene with separate output settings.
- **Timeline JSON → Save JSON…** saves the timeline for other tools or inspection.

A new render supports MP4/H.264 with Cairo. Choose a resolution preset or enter custom
width and height, then set FPS and quality. Width and height must be even numbers between
64 and 8192, with at most 32 megapixels in total.

Lower **CRF** values produce higher quality and larger files. **Encoding effort** trades
rendering time for compression. Most users can keep the defaults. Advanced options use
one `key=value` entry per line.

A new render always covers the complete Scene; the selected timeline range is only for
preview looping. Changing FPS can change animation and updater behavior because Manim
executes the scene again at that frame rate.

Only one render runs at a time. Use **Cancel export** or the progress notification to
stop it. Cue preserves an existing destination file if rendering or copying fails.
After a successful export, choose **Reveal file** or **Open file**.

## Compare two frames

Click **Compare** to pin the displayed frame as a reference. Edit and save your scene;
the reference stays fixed while the current frame updates.

- **Wipe** places the reference on the left and current frame on the right. Drag the
  divider to compare them.
- **Overlay** blends the two images. Move the slider from reference-only to current-only.
- **Replace reference** pins the currently displayed frame instead.

While Compare is active, seeking and frame stepping capture new current frames. Pressing
Play leaves Compare and returns to video playback. Switching Scene or closing the preview
panel clears the reference.

Frames with different sizes or camera geometry are labelled so you can interpret the
comparison carefully.

## Measure coordinates and distances

Click **Measure** to show rulers and a crosshair over the preview.

- Move the pointer to read `(x, y)` in Manim units.
- Click to pin a point.
- Drag from the pinned point to measure horizontal, vertical, and straight-line distance.
- Choose **Copy point** to copy `[x, y, 0]`.
- Choose **Clear**, or press Escape over the preview, to clear the selection.

Measurement uses the configured Manim frame dimensions and works best with a centred,
unrotated 2D camera. Camera movement, 3D projection, and custom cropping can make the
reported coordinates differ from the coordinates you expect in the scene.
