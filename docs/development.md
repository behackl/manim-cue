# Development and tests

## Set up the repository

Install Node.js 24, pnpm and uv. Then install the dependencies, the Chrome build for the
interface tests, and build the extension:

```sh
pnpm install
pnpm exec playwright-core install chrome
pnpm build
```

On Linux, `playwright-core install chrome` installs Google Chrome with the system package
manager and asks for administrator rights. The interface tests use Chrome because it
plays the H.264 test video.

For the tests with Manim, create an environment with the `refactor/audio-mixer` branch
(see the [README](../README.md#get-started)) and set `MANIM_PYTHON` to the Python
executable of that environment.

## Run the extension

Open this repository in VS Code and press **F5**, or start an Extension Development Host
from a terminal:

```sh
code --new-window --extensionDevelopmentPath="$PWD" "$PWD/examples"
```

Select the Manim environment in the Extension Development Host, then open a scene.

## Run the checks

```sh
pnpm check                                      # TypeScript type check
pnpm test                                       # TypeScript unit tests
pnpm test:python                                # Python helper tests, with uv
pnpm test:ui                                    # interface tests in Chrome
MANIM_PYTHON=/path/to/python pnpm test:integration
MANIM_PYTHON=/path/to/python pnpm test:vscode   # complete extension test
pnpm test:vscode:activation                     # start-up and export copy test
pnpm package                                    # build a local stable VSIX
pnpm package:pre-release                        # build a local pre-release VSIX
```

`pnpm test:python` runs `uv run --no-project python -m unittest`. The helper tests need
only the standard library of Python.

The interface tests and the VS Code tests open windows. On Linux without a display, run
them with `xvfb-run`:

```sh
xvfb-run -a pnpm test:ui
MANIM_PYTHON=/path/to/python xvfb-run -a pnpm test:vscode
```

`pnpm test:vscode` uses the extension in `dist/`, so run `pnpm build` (or `pnpm test:ui`)
first.

The integration tests run real Manim: frames, timelines, videos, skipped sections,
exports, cancellation and caches. The interface tests use fixtures. The complete extension
test starts VS Code with a separate profile and runs the example scene from start to end.

### Choose a VS Code version for the extension tests

By default, the extension tests use the installed VS Code and copy the installed Microsoft
Python extension into a temporary test profile.

To download specific versions into the temporary profile, set `VSCODE_VERSION` and
`PYTHON_EXTENSION_VERSION`:

```sh
VSCODE_VERSION=1.96.0 \
PYTHON_EXTENSION_VERSION=2024.22.2 \
pnpm test:vscode:activation
```

To test another local VS Code build, set `VSCODE_EXECUTABLE=/path/to/code` instead. The
test profile has its own settings, extensions and workspace files.

## Continuous integration

The workflow in `.github/workflows/ci.yml` runs:

- the type check, the unit tests, the Python helper tests and the build on Linux, macOS
  and Windows;
- the interface tests on Linux;
- the start-up tests with VS Code 1.96.0 and the current stable release;
- the VSIX packaging;
- the integration tests and the complete extension test with real Manim on Linux.

The Manim job installs the `refactor/audio-mixer` branch and writes the commit of the
branch into the job summary, so that a failure from a change in Manim is easy to find.
The workflow runs for pushes and pull requests, on request, and each day.

## Release

Change the version in `package.json` and add an entry to `CHANGELOG.md` in the same
commit, then push it to `main`. A tag `vX.Y.Z` must have the version of the package. A
pushed tag runs the complete CI, packages one VSIX and creates a GitHub Release with
that file. With `preview: true`, the VSIX is a Marketplace pre-release; remove that field
for a stable release.

Upload the VSIX of the release on the Visual Studio Marketplace publisher page.

## Package locally

```sh
pnpm package
```

This makes a `.vsix` file for a local review. Publish to the Marketplace with `vsce`, and
use the reviewed file.

The notices for the test fixtures and the bundled helpers are in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
