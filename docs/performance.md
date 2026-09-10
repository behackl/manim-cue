# Preview performance

The time needed for an update depends mostly on how much work your scene performs before
the selected frame, how expensive its geometry and updaters are, and whether text or
formula assets are already cached.

## Make editing faster

Try these changes when previews feel slow:

1. **Turn off Auto video.** Cue will update the selected frame and timeline after each
   save. Use **Render video** when you are ready to play the scene.
2. **Lower Preview Width.** A width such as 480 is often enough while arranging a scene.
   Increase it for a final check.
3. **Select an earlier time.** Capturing a late frame still requires Manim to execute the
   scene up to that point.
4. **Keep expensive work outside updaters.** Code that rebuilds many objects every frame
   can dominate both frame capture and timeline evaluation.
5. **Reuse text and formula content.** The first rendering of a font, TeX formula, or
   Typst expression is usually slower than later refreshes.
6. **Increase Timeout Seconds** for a scene that is slow but progressing normally.

Cue handles one Manim job at a time. Frame requests are handled before background video
work. An active export finishes or is cancelled before the next preview job begins.

## Caches

Cue keeps Python bytecode and Manim text/typesetting caches in VS Code extension storage.
Warm caches make repeated refreshes faster, especially for scenes with many text or formula
objects. The first run after installing Cue or clearing caches will usually take longer.

Run **Manim Cue: Clear Caches** after changing:

- installed fonts;
- TeX or Typst tools;
- external files used while typesetting;
- packages involved in text layout.

Clearing caches marks the current preview as old and removes Cue's cached data. Your
source files and exported videos stay in place.

## Compare mode

While Compare is active, moving to another scene time captures a new still. This can be
slower than seeking through a completed video. Moving the wipe divider or opacity slider
only redraws the two images and should respond immediately.

For the quickest visual edit cycle, turn off Auto video, choose the frame you care about,
and save. Render the complete video when you need to check motion or timing.
