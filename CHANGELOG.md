# Changelog

## 0.3.0

- Use the new Manim API from the `refactor/audio-mixer` branch. The setup command installs it.
- Show the frame as soon as the scene reaches the selected time; the timeline follows from the same run.
- Take the video and its timeline from the same render.
- Support sections with `skip_animations`: the timeline, seeking and loops use scene time, and
  a skipped part shows a frame from the scene.
- Show the duration of sounds on the timeline.
- Show still waits and skipped plays in their own style, with a legend.
- Show each timeline entry with plain details in the inspector.
- Offer only the frame and the timeline for export when a scene has no plays or waits.
- Use plain, consistent words in all texts. A changed scene shows "Outdated".
- Show the line that names the error when a scene fails; the log has the complete output.
- Show the status in the preview header only. Sound bars show the file name. Times have two decimals.
- Rename the setting Auto Preview to Render Video Automatically
  (`manimCue.renderVideoAutomatically`). If you changed the old setting, set the new one.

## 0.2.1

- Add an opt-in environment setup command using uv or Python's built-in venv support.

## 0.2.0

Initial public preview release of Manim Cue.
