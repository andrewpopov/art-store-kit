import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ARCHIVE_LINE = /^([0-9a-f]{64}) {2}(.+)$/;

export type ArchiveEntry = { sha: string; path: string };
export type ArchiveSettings = {
  root: string;
  requireMount: string;
  snapshotPrefix: string;
  sourceDir: string;
  manifestPath: string;
  extensions: readonly string[];
};
export type ArchiveRemote = {
  label: string;
  isMountpoint(mount: string): boolean;
  ensureDirs(dirs: readonly string[]): void;
  upload(localFile: string, remoteFile: string): void;
  verifyObjects(objectsDir: string, checksumLines: string): { ok: boolean; output: string };
  writeNoClobber(remoteFile: string, content: string): void;
  download(remoteFile: string, localFile: string): void;
};
export type ArchiveDeps = { now?: () => Date; log?: (line: string) => void };
export type ArchiveResult = { count: number; snapshot: string };
export type ArchivePullResult = { selected: number; fetched: number; failed: string[] };

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function archiveObjectName(entry: ArchiveEntry): string {
  return `${entry.sha}${path.extname(entry.path).toLowerCase()}`;
}

export function scanArchiveSource(sourceDir: string, extensions: readonly string[]): ArchiveEntry[] {
  const paths: string[] = [];
  const walk = (relativeDir: string): void => {
    for (const dirent of fs.readdirSync(path.join(sourceDir, relativeDir), { withFileTypes: true })) {
      const relative = relativeDir === '' ? dirent.name : `${relativeDir}/${dirent.name}`;
      if (dirent.isDirectory()) walk(relative);
      else if (dirent.isFile() && extensions.some((ext) => relative.endsWith(`.${ext}`))) paths.push(relative);
    }
  };
  walk('');
  return paths.sort(byBytes).map((relative) => ({ sha: sha256File(path.join(sourceDir, relative)), path: relative }));
}

export function serializeArchiveManifest(entries: readonly ArchiveEntry[]): string {
  return entries.map((entry) => `${entry.sha}  ${entry.path}\n`).join('');
}

export function parseArchiveManifest(text: string): ArchiveEntry[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const match = ARCHIVE_LINE.exec(line);
      if (!match) throw new Error(`malformed archive manifest line: ${line}`);
      const segments = match[2].split('/');
      if (path.isAbsolute(match[2]) || segments.includes('..')) throw new Error(`unsafe archive manifest path: ${match[2]}`);
      return { sha: match[1], path: match[2] };
    });
}

export function checksumLines(entries: readonly ArchiveEntry[]): string {
  const lines = new Set(entries.map((entry) => `${entry.sha}  ${archiveObjectName(entry)}`));
  return [...lines].sort().map((line) => `${line}\n`).join('');
}

export function snapshotStamp(now: Date): string {
  return `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

export function archive(settings: ArchiveSettings, remote: ArchiveRemote, deps: ArchiveDeps = {}): ArchiveResult {
  const entries = scanArchiveSource(settings.sourceDir, settings.extensions);
  if (entries.length === 0) {
    throw new Error(`no ${settings.extensions.map((ext) => `*.${ext}`).join(', ')} files found under ${settings.sourceDir}`);
  }
  if (!remote.isMountpoint(settings.requireMount)) {
    throw new Error(`${remote.label}:${settings.requireMount} is not a mounted filesystem; refusing`);
  }
  const objectsDir = `${settings.root}/objects`;
  remote.ensureDirs([objectsDir, `${settings.root}/manifests`]);
  for (const entry of entries) {
    remote.upload(path.join(settings.sourceDir, entry.path), `${objectsDir}/${archiveObjectName(entry)}`);
  }

  const verification = remote.verifyObjects(objectsDir, checksumLines(entries));
  if (!verification.ok) {
    throw new Error(`verification on ${remote.label} failed; see FAILED lines below\n${verification.output}`.trimEnd());
  }

  const manifest = serializeArchiveManifest(entries);
  fs.writeFileSync(settings.manifestPath, manifest);
  const snapshot = `${settings.snapshotPrefix}-${snapshotStamp((deps.now ?? (() => new Date()))())}.sha256`;
  remote.writeNoClobber(`${settings.root}/manifests/${snapshot}`, manifest);
  deps.log?.(`archived and verified ${entries.length} files on ${remote.label}:${settings.root}`);
  return { count: entries.length, snapshot };
}

export function archivePull(settings: ArchiveSettings, remote: ArchiveRemote, prefix = ''): ArchivePullResult {
  if (!fs.existsSync(settings.manifestPath)) throw new Error(`missing ${settings.manifestPath}`);
  const selected = parseArchiveManifest(fs.readFileSync(settings.manifestPath, 'utf8')).filter((entry) =>
    entry.path.startsWith(prefix),
  );
  if (selected.length === 0) throw new Error(`no manifest entries match prefix '${prefix}'`);

  let fetched = 0;
  for (const entry of selected) {
    const local = path.join(settings.sourceDir, entry.path);
    if (fs.existsSync(local) && sha256File(local) === entry.sha) continue;
    fs.mkdirSync(path.dirname(local), { recursive: true });
    remote.download(`${settings.root}/objects/${archiveObjectName(entry)}`, local);
    fetched += 1;
  }
  const failed = selected
    .filter((entry) => {
      const local = path.join(settings.sourceDir, entry.path);
      return !fs.existsSync(local) || sha256File(local) !== entry.sha;
    })
    .map((entry) => entry.path);
  return { selected: selected.length, fetched, failed };
}
