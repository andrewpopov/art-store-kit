import fs from 'node:fs';
import path from 'node:path';
import { artObjectName, type ArtManifest } from './manifest';
import {
  buildFetchCommand,
  formatCapped,
  hashFile,
  hashOfObjectName,
  storeObject,
  type RemoteStoreTarget,
  type RsyncCommand,
} from './core';
import {
  classifyKeys,
  hashLocalKeys,
  type HydratedRecord,
  type KeyState,
} from './manifest-edit';

export type RsyncRunner = (command: RsyncCommand) => void;
export type PullOptions = {
  publicRoot: string;
  storeDir: string;
  target: RemoteStoreTarget;
  extensions: readonly string[];
  record: HydratedRecord;
  runner: RsyncRunner;
  repair?: boolean;
  discardLocal?: boolean;
  dryRun?: boolean;
  /** Hydrate by hardlink from the store (lane snapshots): nothing may write into a hydrated file in place. */
  linkHydrated?: boolean;
  log?: (line: string) => void;
};
export type PullResult = {
  exitCode: number;
  adopted: string[];
  repaired: string[];
  fetched: string[];
  hydrated: string[];
  localEditsKept: string[];
  problems: string[];
  record: HydratedRecord;
};

const objectNameOf = (manifest: ArtManifest, key: string, extensions: readonly string[]): string =>
  artObjectName(key, manifest.entries[key], extensions);

export function needsHydration(state: KeyState, discardLocal: boolean): boolean {
  return state === 'absent' || state === 'stale-untouched' || (state === 'local-edit' && discardLocal);
}

export function planFetch(
  manifest: ArtManifest,
  states: ReadonlyMap<string, KeyState>,
  discardLocal: boolean,
  available: ReadonlySet<string>,
  extensions: readonly string[],
): string[] {
  const missing = new Set<string>();
  for (const [key, state] of states) {
    const name = objectNameOf(manifest, key, extensions);
    if (needsHydration(state, discardLocal) && !available.has(name)) missing.add(name);
  }
  return [...missing].sort();
}

function availableObjects(
  manifest: ArtManifest,
  storeDir: string,
  states: ReadonlyMap<string, KeyState>,
  extensions: readonly string[],
): Set<string> {
  const available = new Set<string>();
  for (const [key, state] of states) {
    const name = objectNameOf(manifest, key, extensions);
    if (state === 'in-sync' || fs.existsSync(path.join(storeDir, name))) available.add(name);
  }
  return available;
}

function isIntact(storeDir: string, name: string): boolean {
  const file = path.join(storeDir, name);
  return fs.existsSync(file) && hashFile(file) === hashOfObjectName(name);
}

const LINK_FALLBACK_CODES = new Set(['EXDEV', 'EPERM']);

function linkOrCopy(source: string, tmp: string): void {
  try {
    fs.linkSync(source, tmp);
  } catch (error) {
    if (!LINK_FALLBACK_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    fs.copyFileSync(source, tmp, fs.constants.COPYFILE_FICLONE);
  }
}

function writeAtomically(source: string, dest: string, link: boolean): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  if (link) linkOrCopy(source, tmp);
  else fs.copyFileSync(source, tmp, fs.constants.COPYFILE_FICLONE);
  fs.renameSync(tmp, dest);
}

function adoptInSync(
  manifest: ArtManifest,
  states: ReadonlyMap<string, KeyState>,
  options: PullOptions,
): { adopted: string[]; repaired: string[] } {
  const adopted: string[] = [];
  const repaired: string[] = [];
  for (const [key, state] of states) {
    if (state !== 'in-sync') continue;
    const name = objectNameOf(manifest, key, options.extensions);
    if (!options.dryRun && storeObject(path.join(options.publicRoot, key), options.storeDir, name) === 'repaired') {
      repaired.push(name);
    }
    if (options.record[key] !== manifest.entries[key]) adopted.push(key);
  }
  return { adopted, repaired };
}

function fetchObjects(names: readonly string[], options: PullOptions): { corrupt: string[]; failure: string | null } {
  if (names.length === 0 || options.dryRun) return { corrupt: [], failure: null };
  fs.mkdirSync(options.storeDir, { recursive: true }); // rsync creates only the last path segment
  try {
    options.runner(buildFetchCommand(options.storeDir, options.target, names));
  } catch (error) {
    return { corrupt: [], failure: error instanceof Error ? error.message : String(error) };
  }
  const corrupt: string[] = [];
  for (const name of names) {
    const file = path.join(options.storeDir, name);
    if (fs.existsSync(file) && hashFile(file) !== hashOfObjectName(name)) {
      fs.unlinkSync(file);
      corrupt.push(name);
    }
  }
  return { corrupt, failure: null };
}

function verifyBeforeHydrate(names: readonly string[], options: PullOptions): string[] {
  const bad = names.filter((name) => fs.existsSync(path.join(options.storeDir, name)) && !isIntact(options.storeDir, name));
  if (bad.length === 0 || !options.repair) return bad.map((name) => `corrupt object (use --repair): ${name}`);
  options.runner(buildFetchCommand(options.storeDir, options.target, bad, true));
  return bad.filter((name) => !isIntact(options.storeDir, name)).map((name) => `corrupt object after repair: ${name}`);
}

export function pull(manifest: ArtManifest, options: PullOptions): PullResult {
  const discardLocal = options.discardLocal ?? false;
  const record: HydratedRecord = { ...options.record };
  const result: PullResult = { exitCode: 0, adopted: [], repaired: [], fetched: [], hydrated: [], localEditsKept: [], problems: [], record };
  const local = hashLocalKeys(Object.keys(manifest.entries), options.publicRoot);
  const states = classifyKeys(manifest, local, record);

  ({ adopted: result.adopted, repaired: result.repaired } = adoptInSync(manifest, states, options));
  for (const key of result.adopted) record[key] = manifest.entries[key];

  const toFetch = planFetch(
    manifest,
    states,
    discardLocal,
    availableObjects(manifest, options.storeDir, states, options.extensions),
    options.extensions,
  );
  const fetch = fetchObjects(toFetch, options);
  result.fetched = toFetch.filter((name) => !fetch.corrupt.includes(name));
  if (fetch.failure) result.problems.push(`fetch failed: ${fetch.failure}`);
  result.problems.push(...fetch.corrupt.map((name) => `corrupt fetched object deleted: ${name}`));

  const hydrateKeys = [...states].filter(([, state]) => needsHydration(state, discardLocal)).map(([key]) => key);
  result.localEditsKept = [...states].filter(([, s]) => s === 'local-edit' && !discardLocal).map(([key]) => key);
  if (options.dryRun) {
    result.hydrated = hydrateKeys;
    return result;
  }

  const names = [...new Set(hydrateKeys.map((key) => objectNameOf(manifest, key, options.extensions)))];
  if (result.problems.length === 0) {
    result.problems.push(
      ...names.filter((name) => !fs.existsSync(path.join(options.storeDir, name))).map((name) => `object missing after fetch: ${name}`),
      ...verifyBeforeHydrate(names, options),
    );
  }
  if (result.problems.length > 0) {
    result.exitCode = 1;
    return result;
  }
  for (const key of hydrateKeys) {
    const dest = path.join(options.publicRoot, key);
    const current = fs.existsSync(dest) ? hashFile(dest) : null;
    if (!discardLocal && current !== (local.get(key) ?? null)) {
      result.localEditsKept.push(key);
      continue;
    }
    writeAtomically(path.join(options.storeDir, objectNameOf(manifest, key, options.extensions)), dest, options.linkHydrated ?? false);
    record[key] = manifest.entries[key];
    result.hydrated.push(key);
  }
  return result;
}

export function reportPull(result: PullResult, dryRun: boolean): string[] {
  const prefix = dryRun ? 'dry run: would ' : '';
  return [
    ...formatCapped('repaired from local', result.repaired),
    ...formatCapped('local edit kept', result.localEditsKept),
    ...result.problems.map((problem) => `error: ${problem}`),
    `pull: ${prefix}adopt ${result.adopted.length}, fetch ${result.fetched.length} objects, hydrate ${result.hydrated.length}, local edits kept ${result.localEditsKept.length}`,
  ];
}
