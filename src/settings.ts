import * as vscode from 'vscode';

/** Settings that were renamed: the old key, then the new key, both under `manimCue`. */
const renamed: ReadonlyArray<readonly [string, string]> = [['autoPreview', 'renderVideoAutomatically']];

/**
 * Move the values of renamed settings to their new keys, in user, workspace and folder
 * settings. A value of the new key stays. VS Code can remove an unregistered key, so the
 * old keys need no declaration.
 */
export async function migrateSettings(): Promise<void> {
  const scopes: Array<readonly [vscode.Uri | undefined, vscode.ConfigurationTarget, 'globalValue' | 'workspaceValue' | 'workspaceFolderValue']> = [
    [undefined, vscode.ConfigurationTarget.Global, 'globalValue'],
    ...(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
      ? [[undefined, vscode.ConfigurationTarget.Workspace, 'workspaceValue'] as const] : []),
    // Folder settings exist apart from workspace settings only in a multi-root workspace.
    ...(vscode.workspace.workspaceFile ? (vscode.workspace.workspaceFolders ?? []).map(folder =>
      [folder.uri, vscode.ConfigurationTarget.WorkspaceFolder, 'workspaceFolderValue'] as const) : []),
  ];
  for (const [resource, target, field] of scopes) {
    const config = vscode.workspace.getConfiguration('manimCue', resource);
    for (const [from, to] of renamed) {
      const old = config.inspect(from)?.[field];
      if (old === undefined) continue;
      if (config.inspect(to)?.[field] === undefined) await config.update(to, old, target);
      await config.update(from, undefined, target);
    }
  }
}
