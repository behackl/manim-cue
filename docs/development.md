# Development and tests

## Set up the repository

Install Node.js 24, pnpm, and uv. Then install dependencies, install the Chrome build
used by the interface tests, and build the extension:

```sh
pnpm install
pnpm exec playwright-core install chrome
pnpm build
```

For tests that run Manim, create an environment using the preview branch described in
the [README](../README.md#get-started). Set `MANIM_PYTHON` to that environment's Python
executable.

## Run the extension

Open this repository in VS Code and press **F5**, or launch an Extension Development Host
from a terminal:

```sh
code --new-window --extensionDevelopmentPath="$PWD" "$PWD/examples"
```

Select the Manim environment inside the Extension Development Host before opening a Scene.

## Run checks

```sh
pnpm check                                      # TypeScript type checking
pnpm test                                       # TypeScript unit tests
pnpm test:python                                # Python helper tests
pnpm test:ui                                    # browser interface tests
MANIM_PYTHON=/path/to/python pnpm test:integration
MANIM_PYTHON=/path/to/python pnpm test:vscode   # complete extension test
pnpm test:vscode:activation                     # startup and file-operation test
pnpm package                                    # build a local VSIX
```

The integration tests exercise frame capture, timeline evaluation, preview rendering,
exports, cancellation, and cache behavior with a real Manim installation. The browser
tests use fixtures so interface behavior can be tested quickly. The complete extension
test starts VS Code with an isolated profile and runs the example scene from end to end.

### Choose a VS Code version for extension tests

By default, extension tests use the locally installed VS Code and copy the locally
installed Microsoft Python extension into a temporary test profile.

Set `VSCODE_VERSION` and `PYTHON_EXTENSION_VERSION` to download specific versions into
the temporary profile:

```sh
VSCODE_VERSION=1.96.0 \
PYTHON_EXTENSION_VERSION=2024.22.2 \
pnpm test:vscode:activation
```

Use `VSCODE_EXECUTABLE=/path/to/code` instead when testing another local VS Code build.
The test profile has separate settings, extensions, and workspace files.

## Continuous integration

The workflow in `.github/workflows/ci.yml` runs:

- type checking, unit tests, Python helper tests, and builds on Linux, macOS, and Windows;
- browser interface tests on Linux;
- extension startup tests with VS Code 1.96.0 and the current stable release;
- VSIX packaging;
- real Manim integration and complete extension tests on Linux.

The native Linux job installs Manim from the moving
`refactor/manager-targeted-frame` branch. It records the resolved commit in the GitHub
Actions job summary, making an upstream regression reproducible. The workflow runs for
pushes and pull requests, can be started manually, and runs daily to pick up branch changes.

## Package locally

```sh
pnpm package
```

This creates a `.vsix` file for local review. Marketplace publishing is a separate `vsce`
action and should use the exact reviewed artifact.

Third-party test fixture and bundled-helper notices are listed in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
