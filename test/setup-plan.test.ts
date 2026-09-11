import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MANIM_BRANCH, MANIM_REQUIREMENT, SETUP_PYTHON, setupCommands } from '../src/setup-plan';

test('uv setup creates a fresh environment and installs the moving branch archive without Git', () => {
  const plan = setupCommands({ kind: 'uv', executable: '/tools/uv' }, '/project/.venv', 'linux');
  assert.deepEqual(plan.create, { executable: '/tools/uv', args: ['venv', '--python', SETUP_PYTHON, '/project/.venv'] });
  assert.equal(plan.python, '/project/.venv/bin/python');
  assert.deepEqual(plan.install, { executable: '/tools/uv', args: [
    'pip', 'install', '--python', plan.python, '--refresh-package', 'manim', MANIM_REQUIREMENT,
  ] });
  assert.match(MANIM_REQUIREMENT, new RegExp(`archive/refs/heads/${MANIM_BRANCH.replace('/', '\\/')}\\.zip$`));
  assert.doesNotMatch(MANIM_REQUIREMENT, /git\+|[0-9a-f]{40}/u);
});

test('Python fallback invokes the environment pip directly and bypasses the moving URL cache', () => {
  const plan = setupCommands({ kind: 'python', executable: 'C:\\Python313\\python.exe' }, 'C:\\project\\.venv', 'win32');
  assert.deepEqual(plan.create, { executable: 'C:\\Python313\\python.exe', args: ['-m', 'venv', 'C:\\project\\.venv'] });
  assert.equal(plan.python, 'C:\\project\\.venv\\Scripts\\python.exe');
  assert.deepEqual(plan.install, { executable: plan.python, args: [
    '-m', 'pip', 'install', '--upgrade', '--no-cache-dir', MANIM_REQUIREMENT,
  ] });
});
