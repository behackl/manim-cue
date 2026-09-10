# Using Manim Cue

## Reading the timeline

- **Bar widths are observed execution spans.** At 4 fps an ordinary 0.3 s wait advances
  0.5 s; a frozen 0.3 s wait advances 0.25 s. The inspector keeps these separate from
  the nominal request, evaluated sample count and logical hold intervals.
- Repeated calls at the same source line remain separate events and show occurrence
  numbers. A wait is not duplicated as a second play.
- Section markers are reached declarations. A requested section skip is explicitly
  labeled: no-raster evaluation ignores it, while ordinary rendering may skip output.
- Caption bars and sound diamonds use their **placement**, which can precede the
  declaration. A sound with unknown duration is a point cue, not a made-up waveform/bar.
- Text in the timeline pane is deliberately non-selectable so scrubbing cannot select
  labels. Copy diagnostics from the **Logs** output channel instead.
- Click a bar/cue to inspect it. Double-click, or use **Go to source**, to navigate.
  Left/right select timed calls; zoom controls and horizontal scrolling inspect detail.
- The source root is the primary file's directory. Only primary source bytes are
  fingerprinted; helpers are best-effort navigation and outside-root hints are not links.
- **Manim Cue: Export Timeline JSON** in the Command Palette writes the original,
  verified JSON, retaining its numeric representation and canonical revision.

## Current frame first, movie afterward

On an edit, Cue keeps the last picture—still or paused movie—visible with an **OLD
PREVIEW** marker until its replacement is decoded. After saving, it
executes a fresh scene up to your selected time and shows the captured frame as soon as
it is decoded. The timeline refresh runs next. A successful frame remains usable even
if later timeline evaluation fails.

The **Auto video** setting renders a complete muted movie after the frame and timeline
are ready and you have been idle for 1.5 seconds. Disable it for frame-and-timeline
updates only; it is enabled by default.
Use **Manim Cue: Refresh Timeline Only** for evaluation alone, or **Render video** to
request a complete movie explicitly.

- Drag the preview scrubber or timeline to select a time. A current movie seeks directly.
  Otherwise Cue captures the latest request after a short settle delay; releasing the
  pointer requests that time immediately. The preview scrubber becomes available when
  the current duration is known.
- **Play** requests a movie if needed, then starts it when ready. Seeking or editing
  clears that playback request. Automatic refreshes remain paused.
- Replacement images decode offscreen. Replacement movies load and seek before the
  swap, so the same preview area stays filled throughout. A newer time selection wins.
- The time display shows the presented frame time and total duration, for example
  `16.100 s / 23.200 s`. Fixed decimal places and reserved width keep controls still
  during playback. An unknown total is shown as `—`. At 4 fps, selecting 0.3 s
  chooses the frame at 0.25 s; Cue retains the requested time separately.
- An unavailable frame produces a labeled **end-state snapshot**. When a shortened movie
  is ready, Cue adjusts the position to its last verified frame and reports the change.
  Switching Scene resets the position to zero.

Frame, timeline, and movie are separate executions under the same checked source and
profile. Movie timing checks include nominal rate, decoded presentation timestamps,
duration and section skips. An incompatible movie leaves the current frame visible with
a concrete warning. For a compatible movie, Cue uses its actual frame timestamps to
seek the selected frame. These checks establish timing compatibility, not identical
content across arbitrary Python executions.

### Transport and saved frames

Cue's controls replace the browser's native video controls:

- **Play/Pause** uses icons with tooltips. With the preview focused, Space toggles playback
  and Left/Right step frames. Form controls keep their own keyboard behavior; the timeline
  still uses Left/Right to select timed calls. Frame stepping pauses playback.
- **Render video** appears when Auto video is off and no current movie is ready. It
  prepares playback without starting it; Play requests a movie and starts when ready.
- The **settings cog**, after Measure and Compare, opens VS Code Settings filtered to Cue.
  Set `manimCue.previewWidth` there (for example 480, 960 or 1920); changing width does
  not change FPS. Refresh after changing the rendering profile. Auto video changes take
  effect immediately without invalidating current results.
- **Export…** opens the frame/video/timeline dialog described below. Direct **Save Captured
  Frame as PNG** and **Export Timeline JSON** palette commands remain available.

Cue remembers the last Scene and requested time per workspace, including a paused movie's
position. Reopening that Scene restores its selection; no Python runs merely on activation.
Opening a different Scene starts at zero. With no Python editor active, Open Scene can
reopen the remembered file and class.

Playback is **muted**. Sound cues remain visible on the timeline, and ordinary movie
rendering validates/mixes the scene's sound assets.

## Exporting and rendering

Click **Export…** in the preview controls, or run **Manim Cue: Export…**. Opening the
dialog pauses playback and holds the artifacts/time it describes. New previews do not
silently replace that selection; **Use latest preview** explicitly picks newer results.

- **Current frame → Save PNG…** copies the captured still's pixels, including a visibly
  marked old still. From a current movie, **Capture and save PNG…** executes a fresh
  capture at the held frame using the preview profile, without replacing the preview.
  This is not movie pixel extraction; arbitrary Python can produce different content.
  Unavailable captures fail rather than saving an unrelated or untimed frame.
- **Video → Save existing preview** copies the completed MP4 with its actual resolution,
  FPS and audio. An older movie is explicitly marked **OLD**, even if a newer still is
  already visible. No render settings apply to this copy.
- **Video → New render** executes the whole saved Scene with independent export settings.
  Dirty source requires explicit **Save and Render** confirmation. Preview timeline
  selection/looping does not restrict the export; normal source-defined section skips
  still apply. The exported movie does not replace Cue's preview or comparison pin.
- **Timeline JSON → Save JSON…** copies the original verified observation, preserving
  its canonical numeric representation. It does not reevaluate or apply video settings.

New-render controls use opaque **MP4/H.264, Cairo, yuv420p**:

- Resolution presets specify the short edge and preserve orientation/aspect; exact width
  and height are always visible. Custom dimensions can unlock aspect, changing framing.
  Dimensions must be even, 64–8192 pixels per axis, and no more than 32 megapixels.
- FPS is independent of resolution (1–120, including fractional values). Changing FPS
  re-executes animation/updater semantics, not just playback speed.
- **CRF** defaults to 18: lower means higher quality/larger files. Encoding effort is
  Fast / Balanced / Slow, mapped to `veryfast` / `medium` / `slow` (default Balanced).
- Advanced codec options accept one `key=value` per line, not command-line flags.
  CRF/preset use the visible controls; duplicates and invalid syntax are rejected.
  Cue supplies a complete encoder-option map, replacing inherited project codec options;
  it does not modify project configuration. Encoder failures are reported with logs,
  without a silent codec fallback. Other formats/renderers/custom configuration overrides
  remain CLI workflows for now.

The native Save As picker chooses a local destination. Existing artifacts are retained
through the picker; cancelling it starts no Python work. Accepted render preferences
are remembered per workspace, separately from preview settings.

One native export runs at a time. It interrupts and joins background preview work, then
holds that process slot; queued preview requests coalesce until it finishes. Local movie
scrubbing remains available and does not cancel the export. Source/config/environment
changes or Scene reopening cancel an in-progress render, without automatically restarting
it. Use **Cancel export** or the cancellable progress notification; closing the dialog or
preview panel does not cancel an already accepted job.

Output is prepared privately and copied to a destination-side temporary file before
replacement. Failure/cancellation preserves any previous destination. Success offers
**Reveal file / Open file**. Exports include Scene audio if present, even though Cue's
player is muted. Selected-interval export and comparison-composition export are not built.

## Selecting and looping timeline events

1. Click an event to select it and seek to its start. **Cmd-click** (macOS) or
   **Ctrl-click** toggles additional events without seeking. **Shift-click** selects
   a consecutive range from the anchor event.
2. The shaded region and toolbar label show the interval from the earliest selected
   start to the latest selected end. Intervening events are included, even when their
   boxes are not selected; this is a continuous interval, not a playlist.
3. Enable **Loop selection** above the timeline, then press **Play** in the preview.
   Play prepares a movie if necessary and enters the interval if the cursor is outside it.
   Selecting or toggling a loop pauses playback rather than starting it.

Looping uses the compatible movie's checked presentation timestamps and performs no
Python work on each repeat. Browser seeking can pause briefly at a wrap; this is a
preview loop, not an exported clip. Source/profile changes disable the old loop. Old
observations remain inspectable, with stale selection clearly marked, until refreshed.

The timeline toolbar contains Scene, Refresh, Cancel (while busy), Loop selection,
range and status. Environment checks, logs and timeline JSON export remain in the
Command Palette; errors offer relevant diagnostic actions in the pane.

## Comparing before and after

Click **Compare**, beside Measure, to pin the displayed still as a reference. Edit and
save normally: only the current image updates, while the reference retains its pixels.

- **Wipe** (default) shows the reference on the left and current image on the right.
  Drag the vertical divider or use the slider. With the divider focused, Left/Right
  adjust it; Home/End show current-only/reference-only without seeking the scene.
- **Overlay** blends both images, initially at 50%. Its slider controls the current
  image's opacity: 0% is reference-only, 100% is current-only. Each mode remembers its
  slider position while the webview remains open.
- **Replace reference** pins the displayed current still. Turning Compare off hides the
  comparison but keeps the reference; turning it on again does not silently repin.
- Labels identify each actual capture time and the primary-source SHA-256 prefix.
  These are source identifiers, not full dependency revisions. Untimed snapshots say
  **End state**; old/loading current images remain explicitly marked. A stale still can
  deliberately be pinned, without executing an older source revision.
- Entering from a current movie pauses it and **captures a new still at its presented
  frame** using the public capture API. This is a fresh execution, not extraction of
  the movie's pixels; arbitrary scene code can produce a different result. The new
  reference is pinned only after that capture is decoded. Failed/cancelled captures or
  a superseding seek/edit never substitute an older still or replace an existing pin.
- Seeking and stepping in Compare capture new stills, even if a movie exists. Automatic
  movie rendering/handoff is suspended without changing **Auto video**. Play or the
  explicit Render Preview command exits Compare; normal movie behavior then resumes.
  Compare and Measure are mutually exclusive so their drag gestures cannot conflict.
- Both images are centred and fitted into the current image area without stretching.
  Aspect/frame-geometry changes are flagged; there is no automatic registration or
  camera alignment. Transparent pixels use a neutral dark background for comparison.
- The reference survives refreshes and webview reconstruction within the current panel
  session. Switching Scene, closing the preview panel, or restarting VS Code clears it.
  Reference replacements decode before swapping; a failed decode keeps the previous
  reference visible.

**Export… → Current frame** saves the current captured image, not the wipe/overlay composition.
There is no comparison export, reference gallery or synchronized movie comparison.

## Measuring scene units

Click **Measure** at the right of the preview controls to pause playback and enable top/left
rulers and a pointer crosshair. Works on videos and still images:

- Move to read `(x, y)` in Manim units, with positive Y upward.
- Click to pin a point; drag to measure `Δx`, `Δy` and straight-line distance.
- **Copy point** copies the pinned point/drag endpoint (otherwise pointer) as `[x, y, 0]`,
  rounded to six significant digits. **Clear** or Escape over the measurement surface
  clears the selection.
- Play turns measurement off; enabling measurement pauses playback. Scrubbing and frame
  stepping remain available.
  The mode survives webview recreation; points clear when media is replaced or becomes stale.
- Resizing and letterboxing are accounted for; black margins outside the actual content
  are not part of the measurement surface. Pointer movement never invokes Python.

**This is an explicit fixed-camera assumption, not camera tracking.** The mapping uses
that preview's **configured** frame width and pixel aspect ratio to obtain the reference
height. It assumes the camera is centred at `(0, 0)`, unrotated and fixed throughout a 2D scene. Runtime camera overrides, pan/zoom,
rotation, 3D projection and custom output cropping are not tracked. Measurements are
reference coordinates in this assumed frame, not certified world coordinates or an
`Axes` object's own data coordinates. Old/loading previews have measurement disabled;
new timeline dimensions are never applied to an old video.
