import { test } from 'node:test';
import assert from 'node:assert/strict';
import { model, webview } from './page';

test('the preview header shows which notebook cells run and switches between both ways', async () => {
  const w = await webview('preview');
  try {
    await w.publish(model());
    assert.equal(await w.page.locator('.cells').isHidden(), true, 'a Python file has no cell choice');
    await w.publish(model({ cells: 'needed' }));
    assert.equal(await w.page.locator('.cells-label').textContent(), 'Runs the cells that the scene needs');
    await w.page.getByRole('button', { name: 'Run all above' }).click();
    assert.deepEqual(await w.message('cells'), { kind: 'cells', mode: 'allAbove' });
    await w.publish(model({ cells: 'allAbove' }));
    assert.equal(await w.page.locator('.cells-label').textContent(), 'Runs all cells above');
    await w.page.getByRole('button', { name: 'Run needed cells only' }).click();
    assert.deepEqual(await w.message('cells', 'm.mode === "needed"'), { kind: 'cells', mode: 'needed' });
    if (process.env.CUE_SCREENSHOTS) await w.page.screenshot({ path: `${process.env.CUE_SCREENSHOTS}/preview-cells.png` });
    assert.deepEqual(w.errors, []);
  } finally { await w.browser.close(); }
});

test('the timeline view explains a NameError of a notebook and offers its actions', async () => {
  const w = await webview('timeline');
  try {
    const text = 'The cell starting with “exec(\'RADIUS = 2\')” may set “RADIUS”, but Cue skipped it: Cue runs only the cells that the scene needs.';
    await w.publish(model({ error: "The timeline update failed: NameError: name 'RADIUS' is not defined (line 4 of the cell starting with “class Orbit(Scene):”)",
      problem: { text, actions: ['runCell', 'runAllAbove', 'showCell'] }, cells: 'needed' }));
    assert.equal(await w.page.locator('.error-hint').textContent(), text);
    for (const [name, action] of [['Run This Cell Too', 'runCell'], ['Run All Cells Above', 'runAllAbove'], ['Show Cell', 'showCell']]) {
      await w.page.getByRole('button', { name, exact: true }).click();
      assert.deepEqual(await w.message('problemAction', `m.action === "${action}"`), { kind: 'problemAction', action });
    }
    if (process.env.CUE_SCREENSHOTS) await w.page.screenshot({ path: `${process.env.CUE_SCREENSHOTS}/timeline-problem.png` });
    // Below the scene: only Show Cell helps.
    await w.publish(model({ error: 'x', problem: { text: 'below', actions: ['showCell'] } }));
    assert.deepEqual(await w.page.locator('.error-actions button:visible').allTextContents(), ['Show Cell', 'Show Log']);
    // An error without a notebook problem has no hint and no cell actions.
    await w.publish(model({ error: 'x' }));
    assert.equal(await w.page.locator('.error-hint').isHidden(), true);
    assert.deepEqual(await w.page.locator('.error-actions button:visible').allTextContents(), ['Show Log']);
    assert.deepEqual(w.errors, []);
  } finally { await w.browser.close(); }
});
