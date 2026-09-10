import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

export async function validateDestination(destination: string, extension: string, forbidden: string[]): Promise<void> {
  if (!path.isAbsolute(destination) || path.extname(destination).toLowerCase() !== extension) throw new Error(`Choose a local ${extension} file.`);
  const resolved = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination));
  const real = await fs.realpath(destination).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return resolved; });
  for (const file of forbidden) {
    const blocked = await fs.realpath(file).catch(() => path.resolve(file));
    if ([real, resolved].some(p => p === blocked || p.startsWith(blocked + path.sep))) throw new Error('Export cannot overwrite source, configuration, or private Cue artifacts.');
  }
}
/** Stream/clone to the destination filesystem first; a failed/cancelled export never truncates its destination. */
export async function copyExport(source: string, destination: string, signal: AbortSignal, beforePublish: () => Promise<void> = async () => {}): Promise<void> {
  if (await fs.realpath(source) === await fs.realpath(destination).catch(() => destination)) throw new Error('Source and destination are the same file.');
  const temporary = path.join(path.dirname(destination), `.cue-export-${randomUUID()}.tmp`);
  try {
    signal.throwIfAborted();
    await fs.copyFile(source, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await beforePublish(); signal.throwIfAborted();
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}
