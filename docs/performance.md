# Faster updates

The time of an update depends on the work that your scene does before the selected time,
on its geometry and updaters, and on the text and formula caches.

## Make editing faster

1. **Turn off Render Video Automatically.** Cue then updates the frame and the timeline
   when you save. Click **Render video** when you want to play the scene.
2. **Use a smaller Preview Width.** A width of 480 is often enough to arrange a scene.
3. **Select an earlier time.** For a frame, Cue runs the scene up to the selected time.
4. **Keep expensive work out of updaters.** Code that builds many objects in each frame
   makes each update slower.
5. **Reuse text and formulas.** The first time a font, a TeX formula or a Typst
   expression appears, it takes longer than later.
6. **Increase Timeout Seconds** for a slow scene.

Cue runs one Python process at a time. A frame for a new time comes before the video.
An export finishes, or you cancel it, before the next preview update starts.

## Caches

Cue keeps compiled Python files and the text and typesetting caches of Manim in the
storage of the extension. With warm caches, the next update is faster, mainly for scenes
with much text. The first update after installation or after **Clear Caches** takes
longer.

Run **Manim Cue: Clear Caches** after a change to:

- installed fonts;
- TeX or Typst tools;
- external files for typesetting;
- packages for text layout.

**Clear Caches** makes the preview Outdated and removes the caches of Cue. Your source
files and exported videos stay.

## Compare

In Compare, each new time makes a new frame from a run of the scene. This takes longer
than a seek in the video. The wipe divider and the overlay slider only draw the two
frames again, so they respond at once.

For the fastest edit cycle, turn off Render Video Automatically, choose the frame that
you want to see, and save. Render the video when you want to check motion and timing.
