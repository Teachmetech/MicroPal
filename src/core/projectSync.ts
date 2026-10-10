import { lstat, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { minimatch } from 'minimatch';

export interface SyncFile { localPath: string; remotePath: string; size: number; }
export interface SyncPlan { files: SyncFile[]; totalBytes: number; }

export function remotePathForFile(root: string, file: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The file is outside the selected project, or is the project directory itself.');
  }
  return `/${relative.split(path.sep).join('/')}`;
}

/** A read-only upload plan. Symlinks are never traversed, even if inside the project. */
export async function planSync(root: string, exclusions: readonly string[]): Promise<SyncPlan> {
  const files: SyncFile[] = [];
  const excluded = (relative: string) => exclusions.some(pattern => minimatch(relative, pattern, { dot: true }));
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const localPath = path.join(directory, entry.name);
      const relative = path.relative(root, localPath).split(path.sep).join('/');
      if (entry.isSymbolicLink() || excluded(relative) || (entry.isDirectory() && excluded(`${relative}/`))) continue;
      if (entry.isDirectory()) await walk(localPath);
      else if (entry.isFile()) {
        const info = await lstat(localPath);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        files.push({ localPath, remotePath: `/${relative}`, size: info.size });
      }
    }
  };
  await walk(path.resolve(root));
  files.sort((a, b) => a.remotePath.localeCompare(b.remotePath));
  return { files, totalBytes: files.reduce((sum, file) => sum + file.size, 0) };
}
