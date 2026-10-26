const { runTests, downloadAndUnzipVSCode, runVSCodeCommand } = require('@vscode/test-electron');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const { mkdtempSync } = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

// The test profile (user data, extensions with a copy of the Python extension, the
// workspace, and the temporary files of VS Code) is one folder of several hundred
// megabytes. A supervisor runs the test in its own process group and deletes the folder
// when the test ends, also after a failure or a stop signal.
if (!process.env.CUE_TEST_PROFILE) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'cue-vscode-'));
  const temporary = path.join(scratch, 'tmp');
  const child = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', detached: process.platform !== 'win32',
    env: { ...process.env, CUE_TEST_PROFILE: scratch, TMPDIR: temporary, TMP: temporary, TEMP: temporary } });
  const stop = () => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* The group has ended. */ }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The group has ended. */ } }, 5000).unref();
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  child.on('exit', async code => {
    if (process.platform !== 'win32') try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The group has ended. */ }
    // VS Code processes of a stopped test can still write to the profile for some seconds.
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(error => console.error(`Delete ${scratch} by hand: ${error}`));
    process.exit(code ?? 1);
  });
  return;
}
(async () => {
  const activation = process.argv.includes('--activation');
  if (!activation && !process.env.MANIM_PYTHON) throw new Error('Set MANIM_PYTHON to the supported Manim executable.');
  const version = process.env.VSCODE_VERSION;
  if (version && process.env.VSCODE_EXECUTABLE) throw new Error('Choose VSCODE_VERSION or VSCODE_EXECUTABLE, not both.');
  const root = process.cwd();
  const scratch = process.env.CUE_TEST_PROFILE;
  await fs.mkdir(process.env.TMPDIR);
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
