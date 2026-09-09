# Manim Cue

Preview Manim scenes beside your Python source. Saving updates the selected frame
first, then the execution timeline and a complete movie. The previous picture stays
visible while you work.

- **Frame-first previews:** inspect a moment without waiting for the whole movie.
- **Playback controls:** scrub, step individual frames, or loop a selected timeline interval.
- **Runtime timeline:** inspect animations, waits, sections, captions and sound cues;
  jump back to their source lines.
- **Visual checks:** pin a still for wipe/overlay comparison, measure reference
  coordinates and distances, or save a captured still as PNG.
- **Adjustable preview resolution:** choose smaller previews without changing FPS.

## Get started

Cue is experimental and currently requires a Manim build with
`Manager.capture_frame_at(timestamp)` and `Manager.evaluate(capture_timeline=True)`.
Tested against Manim commit `0fc4f752`; older timeline-capable builds can use full previews.
You also need desktop VS Code 1.96+ and the Microsoft Python extension.

1. Install `manim-cue-0.1.9.vsix` using **Extensions → … → Install from VSIX…**.
2. Open your scene folder in a trusted VS Code window.
3. Use **Python: Select Interpreter** to select the environment containing Manim.
4. Click **▶ Open Manim Cue** above a Scene class, or run **Manim Cue: Open Scene**.

Try `examples/cue_demo.py` for animations, captions and sound cues. Cue remembers the
last Scene and selected time in the workspace; it runs only when you open or refresh it.

## Preview controls

Use the scrubber or timeline to select a time. **Play** prepares a movie if needed;
**Space** toggles playback and **Left/Right** step frames when the preview has focus.
Automatic updates stay paused.

Select timeline events, then enable **Loop selection** to repeat their interval.
Cmd/Ctrl-click toggles events; Shift-click selects a range. Press Play to start.

**Save PNG** saves the displayed captured still; **Measure** enables rulers and a
crosshair. The **settings cog** beside Measure opens Cue's settings, including preview
width and **Auto video** (on by default). Turn Auto video off to work with stills and
the timeline; **Render video** can then prepare a movie without starting playback.

**Compare**, beside Measure, pins a reference still. Use **Wipe** or **Overlay** to compare
it with new frames as you edit; **Replace reference** explicitly updates the pin.

## A few things to know

- Cue executes **saved, trusted Python files**. It is not a sandbox.
- Playback is currently muted. Sound cues remain visible on the timeline.
- Measurement assumes a fixed, centred, unrotated 2D camera.
- The current preview profile uses Cairo. Desktop macOS is tested; remote/web
  workspaces and Windows process cancellation are not yet validated.

## More information

- [Controls, timeline and measurement](docs/usage.md)
- [Python selection and troubleshooting](docs/troubleshooting.md)
- [Performance and caches](docs/performance.md)
- [Execution, freshness and supported scope](docs/architecture.md)
- [Development and validation](docs/development.md)

[Third-party notices](THIRD_PARTY_NOTICES.md) · [License](LICENSE)
