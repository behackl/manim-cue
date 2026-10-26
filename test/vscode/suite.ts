import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Model } from '../../src/protocol';
import type { PythonDiagnostic } from '../../src/diagnostics';
import { PythonExtension } from '@vscode/python-extension';
import { testExportCopies } from './export-copies';
import { isCall } from '../../src/timeline';

export async function run(): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension, 'development extension registered');
  const api = await extension.activate() as { getSnapshot(): Model; whenIdle(): Promise<void>; seek(time: number): void;
    setLoop(range?: { start: number; end: number }): void; pin(id: string): void; setSaveDelay(ms: number): void; submitExport(id: string, choice: unknown): Promise<void> };
  // A short pause after a save; settle() waits for a save notification and that pause.
  api.setSaveDelay(100);
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  await testExportCopies(root);
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
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const settle = async () => { await pause(400); await api.whenIdle(); };
  const until = async (predicate: () => boolean, reason: string) => {
    for (let i = 0; i < 600 && !predicate(); i++) await pause(100);
    assert.ok(predicate(), `${reason}: ${JSON.stringify({ ...api.getSnapshot(), timeline: undefined })}`);
  };
  const insert = async (text: string) => {
    const change = new vscode.WorkspaceEdit(); change.insert(uri, new vscode.Position(0, 0), text);
    assert.equal(await vscode.workspace.applyEdit(change), true);
  };
  const revision = () => api.getSnapshot().timeline?.source?.sha256;
  const savedTimeline = async () => {
    const hash = createHash('sha256').update(await fs.readFile(uri.fsPath)).digest('hex');
    await until(() => !api.getSnapshot().busy && !api.getSnapshot().timelineOutdated && api.getSnapshot().timeline?.source?.sha256 === hash, 'latest saved source published');
  };
  const frameAt = (time: number) => () => api.getSnapshot().frame?.requestedTime === time && !api.getSnapshot().frame?.outdated;
  let state = api.getSnapshot();
  assert.ok(state.timeline, JSON.stringify(state));
  assert.equal(state.timeline.duration, 3.5); assert.equal(state.timeline.entries.filter(isCall).length, 6);
  assert.equal(state.busy, false); assert.equal(state.timelineOutdated, false);
  assert.equal(state.frame?.requestedTime, 0); assert.equal(state.frame?.time, 0);
  const saveDialog = vscode.window.showSaveDialog, png = vscode.Uri.file(path.join(root, 'captured.png'));
  try {
    Object.assign(vscode.window, { showSaveDialog: async () => png });
    await vscode.commands.executeCommand('manimCue.saveFrame');
    assert.deepEqual(await fs.readFile(png.fsPath), await fs.readFile(api.getSnapshot().frame!.id), 'PNG export copies the frame');
    const original = await fs.readFile(png.fsPath);
    // A private file is never a valid destination, even with the right suffix.
    const token = api.getSnapshot().frame!.id, captured = await fs.readFile(token);
    const errorDialog = vscode.window.showErrorMessage;
    const failures: string[] = [];
    try {
      Object.assign(vscode.window, { showErrorMessage: async (message: string) => { failures.push(message); } });
      Object.assign(vscode.window, { showSaveDialog: async () => vscode.Uri.file(token) });
      await vscode.commands.executeCommand('manimCue.saveFrame');
      assert.match(failures.at(-1) ?? '', /belongs to the scene or to Manim Cue/);
      assert.deepEqual(await fs.readFile(token), captured);
      Object.assign(vscode.window, { showSaveDialog: async () => png.with({ scheme: 'untitled' }) });
      await vscode.commands.executeCommand('manimCue.saveFrame');
      assert.match(failures.at(-1) ?? '', /on this computer/);
      assert.deepEqual(await fs.readFile(png.fsPath), original);
    } finally { Object.assign(vscode.window, { showErrorMessage: errorDialog }); }
    const json = vscode.Uri.file(path.join(root, 'direct-timeline.json'));
    Object.assign(vscode.window, { showSaveDialog: async () => json });
    await vscode.commands.executeCommand('manimCue.export');
    assert.deepEqual(JSON.parse(await fs.readFile(json.fsPath, 'utf8')), api.getSnapshot().timeline, 'direct timeline save writes the shown timeline');
  } finally { Object.assign(vscode.window, { showSaveDialog: saveDialog }); }
  // The host keeps the comparison reference through refreshes.
  const firstFrame = api.getSnapshot().frame!.id, firstBytes = await fs.readFile(firstFrame);
  api.pin(firstFrame);
  assert.equal(api.getSnapshot().reference?.id, firstFrame);
  api.pin('/not/a/frame.png');
  assert.equal(api.getSnapshot().reference?.id, firstFrame, 'only the current frame can be the reference');
  await vscode.workspace.getConfiguration('manimCue', uri).update('previewWidth', 480, vscode.ConfigurationTarget.WorkspaceFolder);
  await vscode.commands.executeCommand('manimCue.refresh'); await api.whenIdle();
  assert.equal(api.getSnapshot().reference?.id, firstFrame);
  assert.deepEqual(await fs.readFile(firstFrame), firstBytes, 'a refresh keeps the reference file');
  assert.equal(api.getSnapshot().fps, 4, 'the preview width does not change the frame rate');
  await vscode.commands.executeCommand('manimCue.preview'); await api.whenIdle();
  state = api.getSnapshot();
  assert.ok(state.video && !state.video.outdated, JSON.stringify(state.video));
  assert.equal(state.video.duration, 3.5); assert.equal(state.video.frame.height, 8);
  assert.ok(Math.abs(state.video.frame.width - 128 / 9) < 1e-8, 'scene units of the configuration');
  // With a video, a seek needs no frame; the preview steps by itself and reports the position.
  const frameBefore = api.getSnapshot().frame?.id;
  api.seek(1.25);
  await until(() => api.getSnapshot().time === 1.25, 'the preview moves');
  await settle(); // A frame request would make the host busy.
  assert.equal(api.getSnapshot().time, 1.25);
  assert.equal(api.getSnapshot().frame?.id, frameBefore, 'the video has the frame');
  await vscode.commands.executeCommand('manimCue.nextFrame');
  await until(() => api.getSnapshot().time === 1.5, 'the preview steps one frame');
  await vscode.commands.executeCommand('manimCue.previousFrame');
  await until(() => api.getSnapshot().time === 1.25, 'the preview steps back');
  // "Save Frame as PNG" saves the frame at the position: with the video shown there, a new frame.
  const videoFrame = vscode.Uri.file(path.join(root, 'video-frame.png'));
  let suggested: string | undefined;
  Object.assign(vscode.window, { showSaveDialog: async (options: vscode.SaveDialogOptions) => { suggested = options.defaultUri?.fsPath; return videoFrame; } });
  try { await vscode.commands.executeCommand('manimCue.saveFrame'); await api.whenIdle(); } finally { Object.assign(vscode.window, { showSaveDialog: saveDialog }); }
  assert.equal(path.basename(suggested ?? ''), 'CueDemo-1.250s.png');
  const saved = await fs.readFile(videoFrame.fsPath);
  assert.equal(saved.readUInt32BE(16), 480); assert.equal(saved.readUInt32BE(20), 270);
  assert.notDeepEqual(saved, await fs.readFile(api.getSnapshot().frame!.id), 'not the newest frame, which is for 0 s');
  assert.equal(api.getSnapshot().frame?.id, frameBefore, 'the saved frame does not replace the preview frame');
  api.setLoop({ start: 1, end: 2 });
  assert.deepEqual(api.getSnapshot().loop, { start: 1, end: 2 });
  api.setLoop(undefined);
  const edit = new vscode.WorkspaceEdit(); edit.insert(uri, new vscode.Position(0, 0), '# changed\n');
  const waitCall = 'self.wait(0.35, frozen_frame=False)';
  const offset = doc.getText().indexOf(waitCall); assert.ok(offset >= 0);
  edit.replace(uri, new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + waitCall.length)), 'self.wait(0.85, frozen_frame=False)');
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  state = api.getSnapshot();
  assert.equal(state.timelineOutdated, true); assert.equal(state.video?.outdated, true); assert.equal(state.frame?.outdated, true);
  assert.equal(state.job, undefined, 'an unsaved scene makes no frames');
  // Unsaved files never run. A save updates the frame before the timeline.
  const originalRevision = revision();
  await api.whenIdle();
  assert.equal(api.getSnapshot().busy, false); assert.equal(revision(), originalRevision);
  assert.equal(await doc.save(), true);
  await until(frameAt(1.25), 'the frame for the position comes first');
  assert.equal(api.getSnapshot().timelineOutdated, true, 'the timeline is still outdated');
  const stillToken = api.getSnapshot().frame!.id, stillBytes = await fs.readFile(stillToken);
  assert.equal(path.basename(path.dirname(stillToken)), 'preview-media');
  await insert('# edit again while only the frame is ready\n');
  await api.whenIdle();
  assert.equal(api.getSnapshot().frame?.id, stillToken, 'an edit keeps the frame');
  assert.equal(api.getSnapshot().frame?.outdated, true);
  assert.deepEqual(await fs.readFile(stillToken), stillBytes, 'the cleanup keeps the frame file');
  await doc.save(); await savedTimeline();
  assert.notEqual(revision(), originalRevision);
  assert.equal(api.getSnapshot().time, 1.25, 'the update keeps the position');
  assert.equal(api.getSnapshot().timeline?.duration, 4, 'the update runs the changed timing');
  assert.ok(frameAt(1.25)());
  const afterSave = api.getSnapshot().frame!.id;
  await settle();
  assert.equal(api.getSnapshot().frame!.id, afterSave, 'a duplicate watcher notification does not start a new update');
  assert.equal(api.getSnapshot().busy, false);
  assert.equal(api.getSnapshot().reference?.id, firstFrame);
  assert.deepEqual(await fs.readFile(firstFrame), firstBytes, 'the reference survives saves and cleanups');

  // Export holds exact artifacts across a native Save As dialog and unrelated seeks.
  const exportDialog = async () => {
    await vscode.commands.executeCommand('manimCue.openExport');
    await until(() => !!api.getSnapshot().exportState?.dialog, 'export dialog receives its held artifacts');
    return api.getSnapshot().exportState!.dialog!;
  };
  const originalSave = vscode.window.showSaveDialog;
  const output = vscode.Uri.file(path.join(root, 'export.png'));
  try {
    const held = api.getSnapshot().frame!.id, bytes = await fs.readFile(held);
    let release!: () => void, entered = false;
    const picker = new Promise<void>(resolve => { release = resolve; });
    Object.assign(vscode.window, { showSaveDialog: async () => { entered = true; await picker; return output; } });
    let dialog = await exportDialog();
    const saving = api.submitExport(dialog.id, { ...dialog.choice, kind: 'frame', method: 'copy' });
    await until(() => entered, 'native Save As opened');
    api.seek(1.5);
    await until(frameAt(1.5), 'a copy export does not block preview updates');
    assert.deepEqual(await fs.readFile(held), bytes, 'held frame survives preview replacement while Save As is open');
    release(); await saving;
    assert.deepEqual(await fs.readFile(output.fsPath), bytes, 'PNG copies the held pixels, not the replacement');
    api.seek(1.25); await api.whenIdle();
    await until(frameAt(1.25), 'back to the frame at 1.25 s');
    Object.assign(vscode.window, { showSaveDialog: async () => vscode.Uri.file(path.join(root, 'export.json')) });
    dialog = await exportDialog();
    await api.submitExport(dialog.id, { ...dialog.choice, kind: 'timeline', method: 'copy' });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'export.json'), 'utf8')), api.getSnapshot().timeline, 'JSON is the shown timeline');
    await vscode.commands.executeCommand('manimCue.preview'); await api.whenIdle();
    await until(() => api.getSnapshot().video?.outdated === false, 'video ready for export');
    const movieBytes = await fs.readFile(api.getSnapshot().video!.id);
    Object.assign(vscode.window, { showSaveDialog: async () => vscode.Uri.file(path.join(root, 'export.mp4')) });
    dialog = await exportDialog();
    await api.submitExport(dialog.id, { ...dialog.choice, kind: 'video', method: 'copy' });
    assert.deepEqual(await fs.readFile(path.join(root, 'export.mp4')), movieBytes, 'existing video copies without rerendering');
    Object.assign(vscode.window, { showSaveDialog: async () => output });
    // The preview opens the dialog for the video once it shows the video.
    for (let i = 0; i < 50 && !(dialog = await exportDialog()).canCapture; i++) await pause(200);
    assert.equal(dialog.canCapture, true);
    await api.submitExport(dialog.id, { ...dialog.choice, kind: 'frame', method: 'copy' });
    const capturedPng = await fs.readFile(output.fsPath);
    assert.equal(capturedPng.readUInt32BE(16), 480); assert.equal(capturedPng.readUInt32BE(20), 270);
    assert.ok(frameAt(1.25)(), 'a frame for export does not replace the preview frame');
    Object.assign(vscode.window, { showSaveDialog: async () => vscode.Uri.file(path.join(root, 'export.mp4')) });
    dialog = await exportDialog();
    const settings = { width: 320, height: 180, fps: 8, crf: 18, preset: 'medium', options: 'threads=1' };
    const rendering = api.submitExport(dialog.id, { kind: 'video', method: 'render', settings });
    await until(() => api.getSnapshot().exportState?.nativeBusy === true, 'explicit export owns the serial process slot');
    api.seek(2.25); // Local scrubbing must not cancel an accepted export.
    await rendering; await api.whenIdle();
    assert.match(api.getSnapshot().exportState?.status ?? '', /^Saved /);
    assert.notDeepEqual(await fs.readFile(path.join(root, 'export.mp4')), movieBytes, 'new render has independent output');
    assert.equal(api.getSnapshot().fps, 4);
    assert.equal(api.getSnapshot().reference?.id, firstFrame);
    assert.equal(api.getSnapshot().video?.outdated, false, 'the export does not replace the preview video');
    const validExport = await fs.readFile(path.join(root, 'export.mp4'));
    dialog = await exportDialog();
    await api.submitExport(dialog.id, { kind: 'video', method: 'render', settings: { ...settings, options: 'profile=not-a-profile' } });
    assert.doesNotMatch(api.getSnapshot().exportState?.status ?? '', /^Saved /);
    assert.deepEqual(await fs.readFile(path.join(root, 'export.mp4')), validExport, 'encoder failure preserves the prior destination');
    dialog = await exportDialog();
    const cancelledExport = api.submitExport(dialog.id, { kind: 'video', method: 'render', settings });
    await until(() => api.getSnapshot().exportState?.nativeBusy === true, 'cancel target export starts');
    await vscode.commands.executeCommand('manimCue.cancel'); await cancelledExport; await api.whenIdle();
    assert.match(api.getSnapshot().exportState?.status ?? '', /cancel/i);
    assert.deepEqual(await fs.readFile(path.join(root, 'export.mp4')), validExport);
    dialog = await exportDialog();
    const editedExport = api.submitExport(dialog.id, { kind: 'video', method: 'render', settings });
    await until(() => api.getSnapshot().exportState?.nativeBusy === true, 'source mutation target export starts');
    await insert('# source edit cancels an export\n');
    await editedExport; await api.whenIdle();
    assert.match(api.getSnapshot().exportState?.status ?? '', /The scene changed/);
    assert.deepEqual(await fs.readFile(path.join(root, 'export.mp4')), validExport, 'source invalidation preserves the destination');
    const warningDialog = vscode.window.showWarningMessage;
    let saveConsent = false;
    try {
      Object.assign(vscode.window, { showWarningMessage: async (message: string) => {
        assert.match(message, /Save the scene file and render/); saveConsent = true; return 'Save and Render';
      } });
      dialog = await exportDialog(); assert.equal(dialog.dirty, true);
      await api.submitExport(dialog.id, { kind: 'video', method: 'render', settings });
      assert.equal(saveConsent, true, 'dirty source requires explicit save-and-render consent');
      assert.match(api.getSnapshot().exportState?.status ?? '', /^Saved /, 'the accepted save notification does not cancel its own export');
      await savedTimeline();
    } finally { Object.assign(vscode.window, { showWarningMessage: warningDialog }); }
    api.seek(1.25); await api.whenIdle();
  } finally { Object.assign(vscode.window, { showSaveDialog: originalSave }); }

  // An external saved write also refreshes, even though onDidSaveTextDocument does not fire.
  await fs.appendFile(uri.fsPath, '\n# external save\n');
  await savedTimeline();

  // Superseding saves interrupt an active run and publish only the latest input.
  const beforeRapid = revision();
  await insert('# first save\n'); await doc.save();
  await until(() => /Updating/.test(api.getSnapshot().status), 'first saved run started');
  await insert('# second save\n'); await doc.save();
  assert.equal(revision(), beforeRapid, 'superseded run has not replaced the prior observation');
  await savedTimeline();

  // Save bursts coalesce; cancellation clears a pending debounce as well as active work.
  const beforeCancel = revision();
  api.setSaveDelay(2000); // Time to see the queued update.
  await insert('# first save in burst\n'); await doc.save();
  await insert('# cancel queued refresh\n'); await doc.save();
  await until(() => api.getSnapshot().status.includes('Update queued'), 'save is debounced');
  await vscode.commands.executeCommand('manimCue.cancel');
  api.setSaveDelay(100); await settle();
  assert.equal(api.getSnapshot().busy, false); assert.equal(revision(), beforeCancel);
  assert.match(api.getSnapshot().status, /Cancelled/);

  // Automatic failures retain the last observation, and a subsequent fixed save recovers.
  const goodSource = doc.getText();
  await insert('raise RuntimeError("automatic scene failure")\n'); await doc.save();
  await until(() => !api.getSnapshot().busy && !!api.getSnapshot().error?.includes('automatic scene failure'), 'automatic failure reported in panel');
  assert.equal(revision(), beforeCancel); assert.equal(api.getSnapshot().timelineOutdated, true);
  assert.equal(api.getSnapshot().time, 1.25, 'a failure keeps the position');
  const fix = new vscode.WorkspaceEdit();
  fix.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), goodSource);
  assert.equal(await vscode.workspace.applyEdit(fix), true); await doc.save();
  await savedTimeline(); assert.equal(api.getSnapshot().error, undefined);

  // "Render Video Automatically" renders the video at once; it does not start a new update.
  const timelineBefore = revision();
  await vscode.workspace.getConfiguration('manimCue', uri).update('renderVideoAutomatically', true, vscode.ConfigurationTarget.Workspace);
  await until(() => api.getSnapshot().autoRender && api.getSnapshot().video?.outdated === false, 'the setting renders the video');
  await api.whenIdle();
  assert.equal(revision(), timelineBefore);
  const oldVideo = api.getSnapshot().video?.id;
  await insert('# refresh video too\n'); await doc.save();
  await until(() => api.getSnapshot().busy, 'refresh queued');
  api.seek(2.25); // The latest position during the update wins.
  await savedTimeline();
  await until(() => api.getSnapshot().video?.outdated === false && api.getSnapshot().video?.id !== oldVideo, 'the update renders a new video');
  assert.equal(api.getSnapshot().time, 2.25);

  // Opt-out keeps manual refresh available, without executing on a saved edit.
  await vscode.workspace.getConfiguration('manimCue', uri).update('autoRefreshOnSave', false, vscode.ConfigurationTarget.Workspace);
  const beforeDisabled = revision();
  await insert('# automatic refresh disabled\n'); await doc.save(); await settle();
  assert.equal(api.getSnapshot().busy, false); assert.equal(revision(), beforeDisabled);
  assert.equal(api.getSnapshot().timelineOutdated, true);
  await vscode.commands.executeCommand('manimCue.refresh'); await savedTimeline();
  const job = vscode.commands.executeCommand('manimCue.refresh');
  await until(() => api.getSnapshot().busy, 'the refresh starts');
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
  assert.ok(frameAt(3)(), 'a later failure keeps the frame');
  assert.equal(api.getSnapshot().timelineOutdated, true, 'the old timeline stays outdated');
  const shorter = new vscode.WorkspaceEdit();
  shorter.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
    'from manim import Scene\nclass CueDemo(Scene):\n    def construct(self): self.wait(.5)\nclass Other(Scene):\n    def construct(self): pass\n');
  await vscode.workspace.applyEdit(shorter); await doc.save();
  await vscode.commands.executeCommand('manimCue.refresh'); await savedTimeline();
  await until(() => api.getSnapshot().time === .25, 'the preview moves to the last frame of a shorter scene');
  // A skipped section takes no video time: a frame from an inspection shows it.
  const skipping = new vscode.WorkspaceEdit();
  skipping.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
    'from manim import Scene\nclass CueDemo(Scene):\n    def construct(self):\n        self.wait(.5, frozen_frame=False)\n' +
    '        self.next_section(skip_animations=True)\n        self.wait(1, frozen_frame=False)\n        self.next_section()\n' +
    '        self.wait(1, frozen_frame=False)\nclass Other(Scene):\n    def construct(self): pass\n');
  await vscode.workspace.applyEdit(skipping); await doc.save();
  await vscode.commands.executeCommand('manimCue.refresh'); await savedTimeline();
  await until(() => api.getSnapshot().video?.outdated === false, 'video of a scene with a skipped section');
  assert.equal(api.getSnapshot().video?.duration, 2.5, 'scene time');
  assert.deepEqual(api.getSnapshot().video?.skipped, [{ start: .5, end: 1.5 }]);
  api.seek(1);
  await until(frameAt(1), 'the preview asks for the frame of a skipped part');
  await vscode.commands.executeCommand('manimCue.open', uri, 'Other'); await api.whenIdle();
  assert.equal(api.getSnapshot().time, 0, 'another scene starts at 0');
  assert.equal(api.getSnapshot().reference, undefined, 'another scene has no reference');
  assert.equal(api.getSnapshot().timeline?.duration, 0);
  assert.equal(api.getSnapshot().frame?.time, null, 'the last frame of a scene without plays');
  assert.equal((await exportDialog()).canExportVideo, false, 'a scene without plays exports its frame only');
  await vscode.commands.executeCommand('manimCue.clearCaches');
  assert.match(api.getSnapshot().status, /Caches cleared/);

  await fs.writeFile(path.join(root, 'smoke-success.json'), JSON.stringify({ timelineEnd: state.timeline?.duration, events: state.timeline?.entries.filter(isCall).length, video: !!state.video }));
  console.log('MANIM CUE VS CODE SMOKE PASSED');
}
