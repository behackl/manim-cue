import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Model } from '../../src/protocol';
import type { PythonDiagnostic } from '../../src/diagnostics';
import { PythonExtension } from '@vscode/python-extension';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('manim-cue-local.manim-cue');
  assert.ok(extension, 'development extension registered');
  const api = await extension.activate() as { getSnapshot(): Model; whenIdle(): Promise<void>; seek(time: number): void; select(key: string, mode?: 'replace' | 'toggle' | 'range'): void; setLoop(enabled: boolean): void; setComparison(enabled: boolean, token?: string, time?: number, replace?: boolean): void };
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const uri = vscode.Uri.file(path.join(root, 'cue_demo.py'));
  const doc = await vscode.workspace.openTextDocument(uri); await vscode.window.showTextDocument(doc);
  let lenses: vscode.CodeLens[] = [];
  // Initial Python readiness/environment events can cancel the first discovery.
  // VS Code requests lenses again when the provider invalidates; wait for that state.
  for (let attempt = 0; attempt < 100; attempt++) {
    lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri, 100);
    if (lenses.some(l => l.command?.command === 'manimCue.open')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(lenses.some(l => l.command?.command === 'manimCue.open'), 'Scene CodeLens available after environment initialization');
  assert.ok((await vscode.commands.getCommands()).includes('manimCue.selectPython'));
  const overrideDiagnostic = await vscode.commands.executeCommand<PythonDiagnostic>('manimCue.doctor', uri);
  assert.equal(overrideDiagnostic.status, 'ready', JSON.stringify(overrideDiagnostic));
  await vscode.commands.executeCommand('manimCue.open', uri, 'CueDemo'); await api.whenIdle();
  let state = api.getSnapshot();
  assert.ok(state.timeline, JSON.stringify(state));
  assert.equal(state.timeline.end, 3.5); assert.equal(state.timeline.events.length, 6);
  assert.equal(state.busy, false); assert.equal(state.stale, false);
  assert.equal(state.media?.kind, 'image'); assert.equal(state.media?.capture?.time, 0);
  assert.equal(state.mediaReady, true);
  for (let i = 0; i < 100 && api.getSnapshot().playbackTime === undefined; i++) await new Promise(resolve => setTimeout(resolve, 100));
  const saveDialog = vscode.window.showSaveDialog, png = vscode.Uri.file(path.join(root, 'captured.png'));
  try {
    Object.assign(vscode.window, { showSaveDialog: async () => png });
    await vscode.commands.executeCommand('manimCue.saveFrame');
    assert.deepEqual(await fs.readFile(png.fsPath), await fs.readFile(api.getSnapshot().media!.token), 'PNG export copies displayed pixels');
  } finally { Object.assign(vscode.window, { showSaveDialog: saveDialog }); }
  const firstFrame = api.getSnapshot().media!.token, firstBytes = await fs.readFile(firstFrame);
  api.setComparison(true);
  assert.equal(api.getSnapshot().comparison?.reference?.token, firstFrame, 'activation pins the displayed still without rerendering');
  assert.equal(api.getSnapshot().comparison?.enabled, true);
  assert.equal(api.getSnapshot().comparison?.pending, false);
  api.setComparison(false); api.setComparison(true);
  assert.equal(api.getSnapshot().comparison?.reference?.token, firstFrame, 'toggle keeps reference');
  api.setComparison(true, '/not/a/displayed/file', undefined, true);
  assert.equal(api.getSnapshot().comparison?.reference?.token, firstFrame, 'unowned tokens cannot be pinned');
  await vscode.workspace.getConfiguration('manimCue', uri).update('previewWidth', 480, vscode.ConfigurationTarget.WorkspaceFolder);
  await vscode.commands.executeCommand('manimCue.refresh'); await api.whenIdle();
  assert.equal(api.getSnapshot().previewWidth, 480);
  assert.equal(api.getSnapshot().comparison?.reference?.token, firstFrame);
  assert.deepEqual(await fs.readFile(firstFrame), firstBytes, 'profile refresh retains original reference pixels');
  assert.equal(api.getSnapshot().fps, 4, 'preview width setting does not change execution FPS');
  await vscode.commands.executeCommand('manimCue.preview'); await api.whenIdle();
  for (let attempt = 0; attempt < 100 && api.getSnapshot().playbackTime === undefined; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  state = api.getSnapshot();
  assert.ok(state.playbackTime !== undefined, `Webview must present a decoded frame: ${JSON.stringify(state)}`);
  assert.equal(state.media?.kind, 'video', JSON.stringify(state));
  assert.equal(state.comparison?.enabled, false, 'explicit movie rendering exits still comparison');
  assert.equal(state.media?.frame?.height, 8);
  assert.ok(Math.abs(state.media!.frame!.width - 128 / 9) < 1e-8, 'preview carries configured scene units');
  assert.equal(state.linked, true); assert.equal(state.pairing, '', 'no permanent alignment disclaimer');
  api.seek(1.25);
  for (let i = 0; i < 100 && api.getSnapshot().playbackTime !== 1.25; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(api.getSnapshot().playbackTime, 1.25, 'seek presents the selected frame');
  await vscode.commands.executeCommand('manimCue.nextFrame');
  for (let i = 0; i < 100 && api.getSnapshot().playbackTime !== 1.5; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(api.getSnapshot().playbackTime, 1.5);
  await vscode.commands.executeCommand('manimCue.previousFrame');
  for (let i = 0; i < 100 && api.getSnapshot().playbackTime !== 1.25; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(api.getSnapshot().playbackTime, 1.25);
  const events = state.timeline!.events;
  api.select(`event:${events[1].id}`); api.select(`event:${events[2].id}`, 'toggle'); api.setLoop(true);
  assert.deepEqual(api.getSnapshot().selectedEvents, [events[1].id, events[2].id]);
  assert.equal(api.getSnapshot().selection?.start, 1); assert.equal(api.getSnapshot().selection?.end, 2);
  assert.deepEqual(api.getSnapshot().media?.loop, { start: 1, end: 2 });
  assert.equal(api.getSnapshot().playIntent, undefined, 'selection and loop toggle do not start playback');
  api.select(`event:${events[5].id}`, 'range');
  assert.equal(api.getSnapshot().selectedEvents?.length, 4);
  api.seek(1.25);
  for (let i = 0; i < 100 && api.getSnapshot().playbackTime !== 1.25; i++) await new Promise(resolve => setTimeout(resolve, 100));
  const movieToken = api.getSnapshot().media!.token;
  api.setComparison(true, movieToken, 1.25, true);
  assert.equal(api.getSnapshot().comparison?.pending, true);
  assert.equal(api.getSnapshot().comparison?.reference?.token, firstFrame, 'movie entry does not substitute an older capture');
  await api.whenIdle();
  for (let i = 0; i < 100 && api.getSnapshot().comparison?.pending; i++) await new Promise(resolve => setTimeout(resolve, 100));
  const pinned = api.getSnapshot().comparison!.reference!, pinnedBytes = await fs.readFile(pinned.token);
  assert.equal(api.getSnapshot().media?.kind, 'image');
  assert.equal(pinned.token, api.getSnapshot().media?.token, 'pin follows the decoded fresh capture acknowledgement');
  assert.equal(pinned.capture?.time, 1.25);
  assert.notEqual(pinned.token, firstFrame); assert.notEqual(pinned.token, movieToken);
  assert.equal(pinned.sourceHash, api.getSnapshot().timeline?.source.sha256);
  await vscode.commands.executeCommand('manimCue.preview'); await api.whenIdle();
  for (let i = 0; i < 100 && api.getSnapshot().playbackTime !== 1.25; i++) await new Promise(resolve => setTimeout(resolve, 100));
  api.setComparison(true, api.getSnapshot().media!.token, 1.25, true);
  api.seek(1.5); // Superseding selection cancels pin intent, not the existing reference.
  await api.whenIdle();
  assert.equal(api.getSnapshot().comparison?.pending, false);
  assert.equal(api.getSnapshot().comparison?.reference?.token, pinned.token);
  api.seek(1.25); await api.whenIdle();
  await vscode.workspace.getConfiguration('manimCue', uri).update('autoPreview', true, vscode.ConfigurationTarget.Workspace);
  await api.whenIdle();
  assert.equal(api.getSnapshot().media?.kind, 'image', 'Auto video cannot replace a comparison still');
  const edit = new vscode.WorkspaceEdit(); edit.insert(uri, new vscode.Position(0, 0), '# changed\n');
  const waitCall = 'self.wait(0.35, frozen_frame=False)';
  const offset = doc.getText().indexOf(waitCall); assert.ok(offset >= 0);
  edit.replace(uri, new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + waitCall.length)), 'self.wait(0.85, frozen_frame=False)');
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(api.getSnapshot().stale, true); assert.equal(api.getSnapshot().linked, false);
  assert.equal(api.getSnapshot().selection?.enabled, false, 'source changes disarm the old loop');
  assert.equal(api.getSnapshot().media?.loop, undefined);
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate: () => boolean, reason: string) => {
    for (let i = 0; i < 600 && !predicate(); i++) await pause(100);
    assert.ok(predicate(), `${reason}: ${JSON.stringify(api.getSnapshot())}`);
  };
  const insert = async (text: string) => {
    const change = new vscode.WorkspaceEdit(); change.insert(uri, new vscode.Position(0, 0), text);
    assert.equal(await vscode.workspace.applyEdit(change), true);
  };
  const revision = () => api.getSnapshot().timeline?.revision;
  const savedTimeline = async () => {
    const hash = createHash('sha256').update(await fs.readFile(uri.fsPath)).digest('hex');
    await until(() => !api.getSnapshot().busy && !api.getSnapshot().stale && api.getSnapshot().timeline?.source.sha256 === hash, 'latest saved source published');
  };
  // Dirty buffers are never executed. With Auto video off, saving refreshes the
  // selected frame and timeline, while leaving complete movie generation explicit.
  const originalRevision = revision();
  await pause(800);
  assert.equal(api.getSnapshot().busy, false); assert.equal(revision(), originalRevision);
  assert.equal(await doc.save(), true);
  await until(() => api.getSnapshot().media?.kind === 'image' && api.getSnapshot().media?.capture?.time === 1.25 &&
    api.getSnapshot().mediaReady === true && api.getSnapshot().playbackTime === 1.25, 'saved frame is decoded before timeline completion');
  assert.equal(api.getSnapshot().stale, true, 'new frame is usable while the previous timeline is still stale');
  const stillToken = api.getSnapshot().media!.token, stillBytes = await fs.readFile(stillToken);
  assert.equal(path.basename(path.dirname(stillToken)), 'preview-media');
  await insert('# edit again while only the still is ready\n');
  await api.whenIdle();
  assert.equal(api.getSnapshot().media?.token, stillToken, 'editing during timeline evaluation retains the still');
  assert.equal(api.getSnapshot().media?.old, true);
  assert.deepEqual(await fs.readFile(stillToken), stillBytes, 'cancellation cleanup preserves displayed pixels');
  await doc.save(); await savedTimeline();
  assert.equal(path.dirname(api.getSnapshot().media!.token), path.dirname(stillToken), 'replacement uses the same webview resource root');
  assert.notEqual(revision(), originalRevision);
  assert.equal(api.getSnapshot().position?.time, 1.25, 'frame-first refresh retains the timestamp');
  assert.equal(api.getSnapshot().timeline?.end, 4, 'automatic refresh executes changed timing, not just new labels');
  assert.equal(api.getSnapshot().linked, false); assert.equal(api.getSnapshot().media?.old, false);
  assert.equal(api.getSnapshot().media?.kind, 'image'); assert.equal(api.getSnapshot().media?.capture?.time, 1.25);
  assert.equal(api.getSnapshot().mediaReady, true);
  assert.deepEqual(api.getSnapshot().media?.frame, state.media?.frame, 'capture carries its own reference dimensions');
  const afterSave = api.getSnapshot().generation;
  await pause(900);
  assert.equal(api.getSnapshot().generation, afterSave, 'duplicate watcher notification must not restart a completed run');
  assert.equal(api.getSnapshot().comparison?.reference?.token, pinned.token);
  assert.deepEqual(await fs.readFile(pinned.token), pinnedBytes, 'reference survives saves, cancellation and acknowledged current-media cleanup');
  assert.equal(api.getSnapshot().hasMovie, false, 'saving in Compare suppresses movie work without changing Auto video');
  assert.equal(api.getSnapshot().autoPreview, true);
  await vscode.workspace.getConfiguration('manimCue', uri).update('autoPreview', false, vscode.ConfigurationTarget.Workspace);
  api.setComparison(false);
  assert.equal(api.getSnapshot().comparison?.reference?.token, pinned.token);

  // An external saved write also refreshes, even though onDidSaveTextDocument does not fire.
  await fs.appendFile(uri.fsPath, '\n# external save\n');
  await savedTimeline();

  // Superseding saves interrupt an active run and publish only the latest input.
  const beforeRapid = revision();
  await insert('# first save\n'); await doc.save();
  await until(() => /Capturing frame|Evaluating scene/.test(api.getSnapshot().status), 'first saved run started');
  await insert('# second save\n'); await doc.save();
  assert.equal(revision(), beforeRapid, 'superseded run has not replaced the prior observation');
  await savedTimeline();

  // Save bursts coalesce; cancellation clears a pending debounce as well as active work.
  const beforeCancel = revision();
  await insert('# first save in burst\n'); await doc.save(); await pause(100);
  await insert('# cancel queued refresh\n'); await doc.save();
  await until(() => api.getSnapshot().status.includes('refresh queued'), 'save is debounced');
  await vscode.commands.executeCommand('manimCue.cancel');
  const cancelledGeneration = api.getSnapshot().generation;
  await pause(900); await api.whenIdle();
  assert.equal(api.getSnapshot().generation, cancelledGeneration);
  assert.equal(api.getSnapshot().busy, false); assert.equal(revision(), beforeCancel);
  assert.match(api.getSnapshot().status, /Cancelled/);

  // Automatic failures retain the last observation, and a subsequent fixed save recovers.
  const goodSource = doc.getText();
  await insert('raise RuntimeError("automatic scene failure")\n'); await doc.save();
  await until(() => !api.getSnapshot().busy && !!api.getSnapshot().error?.includes('automatic scene failure'), 'automatic failure reported in panel');
  assert.equal(revision(), beforeCancel); assert.equal(api.getSnapshot().stale, true);
  assert.equal(api.getSnapshot().position?.time, 1.25, 'failure retains selection');
  const fix = new vscode.WorkspaceEdit();
  fix.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), goodSource);
  assert.equal(await vscode.workspace.applyEdit(fix), true); await doc.save();
  await savedTimeline(); assert.equal(api.getSnapshot().error, undefined);

  // Auto video settings take effect immediately without reopening or staling current data.
  const settingsGeneration = api.getSnapshot().generation;
  await vscode.workspace.getConfiguration('manimCue', uri).update('autoPreview', true, vscode.ConfigurationTarget.Workspace);
  await until(() => api.getSnapshot().autoPreview && api.getSnapshot().linked, 'Auto video setting prepares the current movie');
  await api.whenIdle();
  assert.equal(api.getSnapshot().generation, settingsGeneration, 'Auto video is not an execution-profile change');
  const oldMedia = api.getSnapshot().media?.token;
  assert.equal(api.getSnapshot().linked, true);
  await until(() => api.getSnapshot().playbackTime === 1.25, 'replacement video restores selected frame');
  await insert('# refresh video too\n'); await doc.save();
  await until(() => api.getSnapshot().busy, 'refresh queued');
  api.seek(2.25); // Latest user choice during the run wins over its initial position.
  await savedTimeline();
  await until(() => api.getSnapshot().playbackTime === 2.25, 'automatic video restores latest selection');
  assert.equal(api.getSnapshot().linked, true);
  assert.notEqual(api.getSnapshot().media?.token, oldMedia);
  assert.equal(api.getSnapshot().pairing, '');

  // Opt-out keeps manual refresh available, without executing on a saved edit.
  await vscode.workspace.getConfiguration('manimCue', uri).update('autoRefreshOnSave', false, vscode.ConfigurationTarget.Workspace);
  const beforeDisabled = revision();
  await insert('# automatic refresh disabled\n'); await doc.save(); await pause(900);
  assert.equal(api.getSnapshot().busy, false); assert.equal(revision(), beforeDisabled);
  assert.equal(api.getSnapshot().stale, true);
  await vscode.commands.executeCommand('manimCue.refresh'); await savedTimeline();
  const job = vscode.commands.executeCommand('manimCue.refresh');
  await pause(150);
  await vscode.commands.executeCommand('manimCue.cancel'); await job; await api.whenIdle();
  assert.equal(api.getSnapshot().busy, false);
  assert.match(api.getSnapshot().status, /Cancelled/);
  // Exercise the real Python extension API, not only the Cue executable override.
  const pythonApi = await PythonExtension.api(); await pythonApi.ready;
  await pythonApi.environments.updateActiveEnvironmentPath(process.env.MANIM_PYTHON!, uri);
  await vscode.workspace.getConfiguration('manimCue', uri).update('pythonPath', '', vscode.ConfigurationTarget.Workspace);
  const selectedDiagnostic = await vscode.commands.executeCommand<PythonDiagnostic>('manimCue.doctor', uri);
  assert.equal(selectedDiagnostic.status, 'ready', JSON.stringify(selectedDiagnostic));
  assert.equal(selectedDiagnostic.prefix, overrideDiagnostic.prefix, 'API selection preserves the selected virtual environment');
  await vscode.commands.executeCommand('manimCue.refresh'); await savedTimeline();

  // Stub only the user's dialog choices; apply the real picker command, scoped
  // configuration write and subsequent subprocess check in the isolated workspace.
  const dialogs = { showQuickPick: vscode.window.showQuickPick, showInputBox: vscode.window.showInputBox,
    showInformationMessage: vscode.window.showInformationMessage };
  const globalBefore = vscode.workspace.getConfiguration('manimCue', uri).inspect('pythonPath')?.globalValue;
  const revisionBeforePicker = revision();
  let confirmed = false;
  try {
    Object.assign(vscode.window, {
      showQuickPick: async (items: Array<{ action?: string }>) => items.find(item => item.action === 'enter'),
      showInputBox: async () => process.env.MANIM_PYTHON,
      showInformationMessage: async (message: string, options?: { modal?: boolean }) => {
        if (options?.modal) { assert.match(message, /workspace folder/); confirmed = true; return 'Apply'; }
        return undefined;
      },
    });
    await vscode.commands.executeCommand('manimCue.selectPython', uri);
    assert.equal(confirmed, true);
    assert.equal(vscode.workspace.getConfiguration('manimCue', uri).get('pythonPath'), process.env.MANIM_PYTHON);
    assert.equal(vscode.workspace.getConfiguration('manimCue', uri).inspect('pythonPath')?.globalValue, globalBefore);
    assert.equal(revision(), revisionBeforePicker, 'configuring/checking Python does not execute the Scene');
    Object.assign(vscode.window, { showQuickPick: async (items: Array<{ action?: string }>) => items.find(item => item.action === 'follow') });
    await vscode.commands.executeCommand('manimCue.selectPython', uri);
    assert.equal(vscode.workspace.getConfiguration('manimCue', uri).get('pythonPath'), '', 'default mode clears the Cue override and follows the selected interpreter');
  } finally { Object.assign(vscode.window, dialogs); }

  api.seek(3);
  const lateFailure = new vscode.WorkspaceEdit();
  lateFailure.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
    'from manim import Scene, Square\nclass CueDemo(Scene):\n    def construct(self):\n        self.add(Square())\n        self.wait(4)\n        raise RuntimeError("after selected frame")\n');
  await vscode.workspace.applyEdit(lateFailure); await doc.save();
  await vscode.commands.executeCommand('manimCue.refresh'); await api.whenIdle();
  assert.match(api.getSnapshot().error ?? '', /after selected frame/);
  assert.equal(api.getSnapshot().media?.capture?.time, 3);
  assert.equal(api.getSnapshot().mediaReady, true, 'later timeline failure preserves the completed frame');
  assert.equal(api.getSnapshot().stale, true, 'old timeline remains stale independently');
  const shorter = new vscode.WorkspaceEdit();
  shorter.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
    'from manim import Scene\nclass CueDemo(Scene):\n    def construct(self): self.wait(.5)\nclass Other(Scene):\n    def construct(self): pass\n');
  await vscode.workspace.applyEdit(shorter); await doc.save();
  await vscode.commands.executeCommand('manimCue.refresh'); await savedTimeline();
  await until(() => api.getSnapshot().playbackTime === .25, 'shortened movie presents its last frame');
  assert.equal(api.getSnapshot().position!.time, .25, 'clamp to the last verified frame, not the exclusive endpoint');
  assert.match(api.getSnapshot().status, /clamped/);
  await vscode.commands.executeCommand('manimCue.open', uri, 'Other'); await api.whenIdle();
  assert.equal(api.getSnapshot().position?.time, 0, 'switching Scene resets selection');
  assert.equal(api.getSnapshot().comparison?.reference, undefined, 'switching Scene releases its reference');
  assert.equal(api.getSnapshot().comparison?.enabled, false);
  assert.equal(api.getSnapshot().canPlay, false, 'static scenes keep an untimed snapshot');
  assert.equal(api.getSnapshot().media?.capture?.time, null);
  await vscode.commands.executeCommand('manimCue.clearCaches');
  assert.match(api.getSnapshot().status, /caches cleared/);

  await fs.writeFile(path.join(root, 'smoke-success.json'), JSON.stringify({ timelineEnd: state.timeline?.end, events: state.timeline?.events.length, preview: state.media?.kind }));
  console.log('MANIM CUE VS CODE SMOKE PASSED');
}
