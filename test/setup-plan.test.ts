import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { insideEnvironment, MANIM_BRANCH, MANIM_REQUIREMENT, SETUP_PYTHON, setupCommands } from '../src/setup-plan';

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

test('continuous integration exercises the branch and archive the setup command installs', async () => {
  const workflow = await fs.readFile(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, new RegExp(`^\\s*MANIM_BRANCH: ${MANIM_BRANCH}$`, 'mu'), 'CI follows the shipped branch');
  assert.ok(workflow.includes('archive/refs/heads/$MANIM_BRANCH.zip'), 'CI installs the shipped source archive');
  assert.doesNotMatch(workflow, /git\+https:\/\/github\.com\/ManimCommunity/u, 'CI no longer installs a path users do not use');
});

test('package installs never invalidate a scene, while ordinary project files still do', () => {
  assert.ok(insideEnvironment('/project/.venv/lib/python3.13/site-packages/manim/mobject/text.py'));
  assert.ok(insideEnvironment('C:\\project\\.venv\\Lib\\site-packages\\manim\\__init__.py'));
  assert.ok(insideEnvironment('/project/env/lib/python3.13/site-packages/manim/__init__.py'), 'other environment names still contain site-packages');
  assert.ok(!insideEnvironment('/project/scenes/intro.py'));
  assert.ok(!insideEnvironment('/project/.venvy/helpers.py'), 'only complete path segments count');
});
