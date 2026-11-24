import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { insideEnvironment, MANIM_VERSION, SETUP_PYTHON, setupCommands } from '../src/setup-plan';

test('uv setup creates a fresh environment and installs the pinned Manim prerelease', () => {
  const plan = setupCommands({ kind: 'uv', executable: '/tools/uv' }, '/project/.venv', 'linux');
  assert.deepEqual(plan.create, { executable: '/tools/uv', args: ['venv', '--python', SETUP_PYTHON, '/project/.venv'] });
  assert.equal(plan.python, '/project/.venv/bin/python');
  assert.deepEqual(plan.install, { executable: '/tools/uv', args: [
    'pip', 'install', '--python', plan.python, `manim==${MANIM_VERSION}`,
  ] });
});

test('Python fallback installs the same pin using the new environment’s pip', () => {
  const plan = setupCommands({ kind: 'python', executable: 'C:\\Python313\\python.exe' }, 'C:\\project\\.venv', 'win32');
  assert.deepEqual(plan.create, { executable: 'C:\\Python313\\python.exe', args: ['-m', 'venv', 'C:\\project\\.venv'] });
  assert.equal(plan.python, 'C:\\project\\.venv\\Scripts\\python.exe');
  assert.deepEqual(plan.install, { executable: plan.python, args: [
    '-m', 'pip', 'install', `manim==${MANIM_VERSION}`,
  ] });
});

test('continuous integration exercises the exact Manim release that setup installs', async () => {
  const workflow = await fs.readFile(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(workflow.split('\n').some(line => line.trim() === `MANIM_VERSION: '${MANIM_VERSION}'`), 'CI uses the shipped pin');
  assert.ok(workflow.includes('uv pip install --python "$MANIM_PYTHON" "manim==$MANIM_VERSION"'), 'CI installs the shipped requirement');
});

test('package installs never invalidate a scene, while ordinary project files still do', () => {
  assert.ok(insideEnvironment('/project/.venv/lib/python3.13/site-packages/manim/mobject/text.py'));
  assert.ok(insideEnvironment('C:\\project\\.venv\\Lib\\site-packages\\manim\\__init__.py'));
  assert.ok(insideEnvironment('/project/env/lib/python3.13/site-packages/manim/__init__.py'), 'other environment names still contain site-packages');
  assert.ok(!insideEnvironment('/project/scenes/intro.py'));
  assert.ok(!insideEnvironment('/project/.venvy/helpers.py'), 'only complete path segments count');
});
