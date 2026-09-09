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
- The **settings cog**, just after Measure, opens VS Code Settings filtered to Cue.
  Set `manimCue.previewWidth` there (for example 480, 960 or 1920); changing width does
  not change FPS. Refresh after changing the rendering profile. Auto video changes take
  effect immediately without invalidating current results.
- **Save PNG** opens a Save As dialog for the displayed captured still, using its existing
  pixels. A stale still can be saved too; its suggested filename includes `old`.
  This button is disabled for movies. Timeline JSON export is a separately named
  Command Palette action, not a movie export.

Cue remembers the last Scene and requested time per workspace, including a paused movie's
position. Reopening that Scene restores its selection; no Python runs merely on activation.
Opening a different Scene starts at zero. With no Python editor active, Open Scene can
reopen the remembered file and class.

Playback is **muted**. Sound cues remain visible on the timeline, and ordinary movie
rendering validates/mixes the scene's sound assets.

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
