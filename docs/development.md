# Development and validation

## Launch without installing a VSIX

```sh
pnpm install
pnpm build
code --new-window --extensionDevelopmentPath="$PWD" "$PWD/examples"
```

Or open this repository in VS Code and press **F5**. Select the interpreter in the
Extension Development Host before opening a Scene.

## Checks

```sh
pnpm check
pnpm test
pnpm test:python                   # stdlib parser + canonical verification (via uv)
MANIM_PYTHON=/path/to/python pnpm test:integration
pnpm test:ui                       # installed Google Chrome via playwright-core
MANIM_PYTHON=/path/to/python pnpm test:vscode
pnpm package                      # creates a local VSIX; does not publish
```

The VS Code smoke test uses isolated user data and a copy of the locally installed
Microsoft Python extension. `VSCODE_EXECUTABLE` can select another desktop VS Code.
It exercises CodeLens, the real timeline/preview pipeline, decoded video presentation,
stale-state gating, save-triggered refresh, superseding saves, failure recovery and
cancellation, timestamp restoration/clamping and cache clearing. Unit/UI tests consume
the public v1 fixture and a small generated seek-test movie, and do not require Manim.
Measurement UI checks cover letterboxing, resizing at device scale 2, Y orientation,
copy requests, stills, missing dimensions and stale/replacement media. Comparison browser
checks cover wipe/opacity pixels, keyboard/drag controls, high-DPI resizing, stale/current
and reference decode races, view reconstruction, and entry from a playing movie. The
native smoke also checks explicit movie-frame capture, pending-pin cancellation, reference
retention across saves/profile changes, movie suppression and Scene-switch cleanup.
Integration tests explicitly require the supported environment.

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for the public Manim fixture and bundled Python-extension
API helper attribution. The generated demo WAV is original to this project.
