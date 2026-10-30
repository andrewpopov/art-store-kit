import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ART_HASH_HEX_LENGTH, artObjectName, isArtExtension, type ArtManifest } from './manifest';

export const LISTING_CAP = 20;
const RSYNC_CHMOD = '--chmod=F644,D755';

export type StoreProblems = { missing: string[]; corrupt: string[] };
export type MaterializeResult = {
  created: number;
  present: number;
  repaired: string[];
  corrupt: string[];
  missingSources: string[];
  changedSources: string[];
};
export type PublishTarget = { host: string; projectDir: string };
export type RemoteStoreTarget = PublishTarget & { storeName: string };
export type RsyncCommand = { args: string[]; stdin: string };

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, ART_HASH_HEX_LENGTH);
}

export function buildManifest(
  keys: readonly string[],
  readBytes: (key: string) => Uint8Array,
  extensions: readonly string[],
): ArtManifest {
  const entries: Record<string, string> = {};
  for (const key of [...keys].sort()) {
    if (isArtExtension(key, extensions)) entries[key] = hashBytes(readBytes(key));
  }
  return { version: 1, hash: 'sha256-128', entries };
}

export function serializeManifest(manifest: ArtManifest): string {
  const lines = Object.keys(manifest.entries)
    .sort()
    .map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(manifest.entries[key])}`);
  const entries = lines.length ? `{\n${lines.join(',\n')}\n  }` : '{}';
  return `{\n  "version": 1,\n  "hash": "sha256-128",\n  "entries": ${entries}\n}\n`;
}

export function formatCapped(label: string, items: readonly string[], cap = LISTING_CAP): string[] {
  if (items.length === 0) return [];
  const shown = items.slice(0, cap).map((item) => `  ${label}: ${item}`);
  const hidden = items.length - shown.length;
  return [...shown, ...(hidden > 0 ? [`  ... and ${hidden} more ${label}`] : []), `${label} total: ${items.length}`];
}

export function objectNames(manifest: ArtManifest, extensions: readonly string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const [key, hash] of Object.entries(manifest.entries)) {
    const name = artObjectName(key, hash, extensions);
    if (!names.has(name)) names.set(name, key);
  }
  return names;
}

export function hashFile(file: string): string {
  return hashBytes(fs.readFileSync(file));
}

export function hashOfObjectName(name: string): string {
  return name.slice(0, ART_HASH_HEX_LENGTH);
}

export function storeObject(source: string, storeDir: string, name: string): 'created' | 'present' | 'changed' | 'repaired' {
  fs.mkdirSync(storeDir, { recursive: true });
  const tmp = path.join(storeDir, `.tmp-${process.pid}-${name}`);
  const dest = path.join(storeDir, name);
  fs.copyFileSync(source, tmp, fs.constants.COPYFILE_FICLONE);
  try {
    if (hashFile(tmp) !== hashOfObjectName(name)) return 'changed';
    fs.linkSync(tmp, dest);
    return 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (hashFile(dest) === hashOfObjectName(name)) return 'present';
    fs.renameSync(tmp, dest);
    return 'repaired';
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function materialize(
  manifest: ArtManifest,
  publicRoot: string,
  storeDir: string,
  extensions: readonly string[],
): MaterializeResult {
  const result: MaterializeResult = { created: 0, present: 0, repaired: [], corrupt: [], missingSources: [], changedSources: [] };
  fs.mkdirSync(storeDir, { recursive: true });
  for (const [name, key] of objectNames(manifest, extensions)) {
    const dest = path.join(storeDir, name);
    const exists = fs.existsSync(dest);
    if (exists && hashFile(dest) === hashOfObjectName(name)) {
      result.present += 1;
      continue;
    }
    const source = path.join(publicRoot, key);
    if (!fs.existsSync(source)) {
      (exists ? result.corrupt : result.missingSources).push(exists ? name : key);
      continue;
    }
    const stored = storeObject(source, storeDir, name);
    if (stored === 'changed') (exists ? result.corrupt : result.changedSources).push(exists ? name : key);
    else if (stored === 'repaired') result.repaired.push(name);
    else if (stored === 'created') result.created += 1;
    else result.present += 1;
  }
  return result;
}

export function verifyStore(
  manifest: ArtManifest,
  storeDir: string,
  extensions: readonly string[],
): StoreProblems & { checked: number } {
  const problems: StoreProblems & { checked: number } = { missing: [], corrupt: [], checked: 0 };
  for (const name of objectNames(manifest, extensions).keys()) {
    problems.checked += 1;
    const file = path.join(storeDir, name);
    if (!fs.existsSync(file)) problems.missing.push(name);
    else if (hashFile(file) !== hashOfObjectName(name)) problems.corrupt.push(name);
  }
  return problems;
}

export function remoteStoreDir(target: RemoteStoreTarget): string {
  return `${target.projectDir.replace(/\/+$/, '')}/${target.storeName}`;
}

function rsyncDestination(target: RemoteStoreTarget): string {
  return `${target.host}:${remoteStoreDir(target)}/`;
}

function namesToStdin(names: readonly string[]): string {
  return names.map((name) => `${name}\n`).join('');
}

export function buildSendCommand(
  storeDir: string,
  target: RemoteStoreTarget,
  names: readonly string[],
  repair = false,
): RsyncCommand {
  const flags = repair ? ['-rt', '--checksum'] : ['-rt', '--ignore-existing'];
  return {
    args: [...flags, RSYNC_CHMOD, '--files-from=-', `${storeDir}/`, rsyncDestination(target)],
    stdin: namesToStdin(names),
  };
}

export function buildFetchCommand(
  storeDir: string,
  target: RemoteStoreTarget,
  names: readonly string[],
  repair = false,
): RsyncCommand {
  return {
    args: ['-r', repair ? '--checksum' : '--ignore-existing', '--files-from=-', rsyncDestination(target), `${storeDir}/`],
    stdin: namesToStdin(names),
  };
}

export function buildVerifyCommand(storeDir: string, target: RemoteStoreTarget, names: readonly string[]): RsyncCommand {
  return {
    args: ['-rn', '--checksum', '--itemize-changes', '--files-from=-', `${storeDir}/`, rsyncDestination(target)],
    stdin: namesToStdin(names),
  };
}

export function buildMkdirCommand(target: RemoteStoreTarget): string[] {
  return [target.host, 'mkdir', '-p', remoteStoreDir(target)];
}

export function parseItemizedNames(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.replace(/^\S+\s+/, ''));
}

export function listFilesUnder(publicRoot: string, startKey: string): string[] {
  const keys: string[] = [];
  const walk = (relativeDir: string): void => {
    for (const entry of fs.readdirSync(path.join(publicRoot, relativeDir), { withFileTypes: true })) {
      const relative = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile()) keys.push(relative);
    }
  };
  const start = path.join(publicRoot, startKey);
  if (fs.statSync(start, { throwIfNoEntry: false })?.isDirectory()) walk(startKey);
  else if (fs.statSync(start, { throwIfNoEntry: false })?.isFile()) keys.push(startKey);
  return keys;
}
