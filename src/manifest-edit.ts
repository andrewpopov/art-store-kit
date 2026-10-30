import fs from 'node:fs';
import path from 'node:path';
import { hashFile, listFilesUnder } from './core';
import { isArtExtension, type ArtLayout, type ArtManifest } from './manifest';

export type HydratedRecord = Record<string, string>;
export type LocalHashes = Map<string, string | null>;
export type KeyState = 'in-sync' | 'absent' | 'stale-untouched' | 'local-edit';
export type ManifestChanges = { updated: string[]; added: string[]; removed: string[] };
export type KeySpace = ArtLayout & { publicRoot: string; publicRootRelative: string };

export function readHydratedRecord(file: string): HydratedRecord {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as HydratedRecord) : {};
}

export function writeHydratedRecord(file: string, record: HydratedRecord): void {
  const sorted = Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
}

export function hashLocalKeys(keys: Iterable<string>, publicRoot: string): LocalHashes {
  const hashes: LocalHashes = new Map();
  for (const key of keys) {
    const file = path.join(publicRoot, key);
    hashes.set(key, fs.existsSync(file) ? hashFile(file) : null);
  }
  return hashes;
}

export function classifyKey(entry: string, local: string | null | undefined, recorded: string | undefined): KeyState {
  if (local === null || local === undefined) return 'absent';
  if (local === entry) return 'in-sync';
  return recorded === local ? 'stale-untouched' : 'local-edit';
}

export function classifyKeys(manifest: ArtManifest, local: LocalHashes, record: HydratedRecord): Map<string, KeyState> {
  const states = new Map<string, KeyState>();
  for (const [key, entry] of Object.entries(manifest.entries)) {
    states.set(key, classifyKey(entry, local.get(key), record[key]));
  }
  return states;
}

export type LocalEditResult = { manifest: ArtManifest; record: HydratedRecord; updated: string[]; conflicts: string[] };

export function applyLocalEdits(
  manifest: ArtManifest,
  local: LocalHashes,
  record: HydratedRecord,
  takeLocal: readonly string[] = [],
): LocalEditResult {
  const entries = { ...manifest.entries };
  const nextRecord = { ...record };
  const updated: string[] = [];
  const conflicts: string[] = [];
  for (const key of takeLocal) {
    if (!(key in entries)) throw new Error(`--take-local: not in manifest: ${key}`);
    if (!local.get(key)) throw new Error(`--take-local: no local file: ${key}`);
  }
  for (const [key, entry] of Object.entries(manifest.entries)) {
    const hash = local.get(key);
    if (hash === null || hash === undefined) continue;
    const recorded = record[key];
    if (takeLocal.includes(key)) {
      if (hash !== entry) updated.push(key);
    } else if (hash === entry || (recorded !== undefined && recorded !== entry && hash === recorded)) {
      continue;
    } else if (recorded !== entry) {
      conflicts.push(key);
      continue;
    } else {
      updated.push(key);
    }
    entries[key] = hash;
    nextRecord[key] = hash;
  }
  return { manifest: { ...manifest, entries }, record: nextRecord, updated, conflicts };
}

export function normalizeArtKey(arg: string, space: KeySpace): string {
  const relative = path.isAbsolute(arg)
    ? path.relative(space.publicRoot, arg)
    : arg.replace(new RegExp(`^(\\./)?${escapeRegExp(space.publicRootRelative)}/`), '');
  const key = path.posix.normalize(relative.split(path.sep).join('/'));
  if (key !== space.trackedDir && !key.startsWith(`${space.trackedDir}/`)) {
    throw new Error(`Not under ${space.publicRootRelative}/${space.trackedDir}: ${arg}`);
  }
  return key;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveAddKeys(args: readonly string[], space: KeySpace): string[] {
  const keys = new Set<string>();
  for (const arg of args) {
    const start = normalizeArtKey(arg, space);
    const found = listFilesUnder(space.publicRoot, start);
    if (found.length === 0) throw new Error(`No files found at ${arg}`);
    for (const key of found) if (isArtExtension(key, space.extensions)) keys.add(key);
  }
  return [...keys].sort();
}

export function applyAddRemove(
  manifest: ArtManifest,
  added: ReadonlyMap<string, string>,
  removeKeys: readonly string[],
): { manifest: ArtManifest; added: string[]; removed: string[] } {
  const entries = { ...manifest.entries };
  const removed = removeKeys.filter((key) => key in entries);
  for (const key of removed) delete entries[key];
  const newKeys: string[] = [];
  for (const [key, hash] of added) {
    if (key in entries) continue;
    newKeys.push(key);
    entries[key] = hash;
  }
  return { manifest: { ...manifest, entries }, added: newKeys, removed };
}

export function checkLocal(manifest: ArtManifest, local: LocalHashes): { missing: string[]; differs: string[] } {
  const result = { missing: [] as string[], differs: [] as string[] };
  for (const [key, entry] of Object.entries(manifest.entries)) {
    const hash = local.get(key);
    if (hash === null || hash === undefined) result.missing.push(key);
    else if (hash !== entry) result.differs.push(key);
  }
  return result;
}

export function findTrackedImages(trackedFiles: readonly string[], extensions: readonly string[]): string[] {
  return trackedFiles.filter((file) => isArtExtension(file, extensions));
}
