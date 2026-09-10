const { runTests, downloadAndUnzipVSCode, runVSCodeCommand } = require('@vscode/test-electron');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
(async () => {
  const activation = process.argv.includes('--activation');
  if (!activation && !process.env.MANIM_PYTHON) throw new Error('Set MANIM_PYTHON to the supported Manim executable.');
  const version = process.env.VSCODE_VERSION;
  if (version && process.env.VSCODE_EXECUTABLE) throw new Error('Choose VSCODE_VERSION or VSCODE_EXECUTABLE, not both.');
  const root = process.cwd();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cue-vscode-'));
  const workspace = path.join(scratch, 'workspace'); await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
  const extensions = path.join(scratch, 'extensions'); await fs.mkdir(extensions);
  const profileArgs = ['--extensions-dir', extensions, '--user-data-dir', path.join(scratch, 'user-data')];
  await fs.mkdir(path.join(scratch, 'user-data', 'User'), { recursive: true });
  await fs.writeFile(path.join(scratch, 'user-data', 'User', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
  }));
  if (version) {
    // Explicit opt-in: provision only this isolated test profile, never the user's installation.
    if (!process.env.PYTHON_EXTENSION_VERSION) throw new Error('Set PYTHON_EXTENSION_VERSION when downloading test inputs.');
    const installed = await runVSCodeCommand([...profileArgs, '--install-extension', `ms-python.python@${process.env.PYTHON_EXTENSION_VERSION}`, '--force'], { version });
    console.log(installed.stdout, installed.stderr);
  } else {
    const installed = path.join(os.homedir(), '.vscode', 'extensions');
    const pythonExtension = (await fs.readdir(installed)).filter(n => n.startsWith('ms-python.python-')).sort().at(-1);
    if (!pythonExtension) throw new Error('Install Microsoft Python, or set VSCODE_VERSION and PYTHON_EXTENSION_VERSION for isolated downloads.');
    await fs.cp(path.join(installed, pythonExtension), path.join(extensions, pythonExtension), { recursive: true });
  }
  await fs.copyFile('examples/cue_demo.py', path.join(workspace, 'cue_demo.py'));
  await fs.copyFile('examples/cue.wav', path.join(workspace, 'cue.wav'));
  await fs.writeFile(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'manimCue.pythonPath': process.env.MANIM_PYTHON, 'manimCue.frameRate': 4,
    'manimCue.previewWidth': 320, 'manimCue.autoPreview': false,
    'python.defaultInterpreterPath': process.env.MANIM_PYTHON,
    'python.analysis.enabled': false, 'python.useEnvironmentsExtension': false,
  }));
  await build({ entryPoints: [activation ? 'test/vscode/activation.ts' : 'test/vscode/suite.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist/smoke.cjs', external: ['vscode'] });
  console.log('Smoke workspace:', workspace);
  let local = version ? await downloadAndUnzipVSCode(version) : process.env.VSCODE_EXECUTABLE;
  if (!local && process.platform === 'darwin') {
    for (const name of ['Code', 'Electron']) {
      const candidate = `/Applications/Visual Studio Code.app/Contents/MacOS/${name}`;
      try { await fs.access(candidate); local = candidate; break; } catch { /* Try next binary name. */ }
    }
  }
  await runTests({ vscodeExecutablePath: local, extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'dist', 'smoke.cjs'),
    launchArgs: [workspace, ...profileArgs, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates'],
  });
  console.log(await fs.readFile(path.join(workspace, 'smoke-success.json'), 'utf8'));
})().catch(error => { console.error(error); process.exitCode = 1; });
