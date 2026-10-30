import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveSettings } from './archive';
import type { RemoteStoreTarget } from './core';
import type { ArtLayout } from './manifest';
import type { StoreLocation } from './store-location';

export const CONFIG_FILE_NAME = 'art-store.config.json';

export type ArchiveConfig = {
  remote: string;
  root: string;
  sourceDir: string;
  extensions: string[];
  manifest: string;
  requireMount: string;
  snapshotPrefix: string;
};

export type RuntimeStoreConfig = {
  publicRoot: string;
  manifest: string;
  hydratedRecord: string;
  trackedDir: string;
  extensions: string[];
  store: StoreLocation;
};

export type ArtStoreConfig = Partial<RuntimeStoreConfig> & {
  publish?: { host: string; projectDir: string };
  archive?: ArchiveConfig;
};

export type ResolvedRuntime = {
  publicRoot: string;
  publicRootRelative: string;
  manifestPath: string;
  recordPath: string;
  layout: ArtLayout;
  store: StoreLocation;
};

export type ResolvedConfig = {
  repoRoot: string;
  runtime: ResolvedRuntime | null;
  publish: RemoteStoreTarget | null;
  archive: { remote: string; settings: ArchiveSettings } | null;
};

const RUNTIME_KEYS = ['publicRoot', 'manifest', 'hydratedRecord', 'trackedDir', 'extensions', 'store'] as const;
const EXTENSION_PATTERN = /^[a-z0-9]+$/;

type Fields = Record<string, unknown>;

function asObject(value: unknown, where: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${CONFIG_FILE_NAME}: ${where} must be an object`);
  return value as Fields;
}

function stringField(fields: Fields, key: string, where: string): string {
  const value = fields[key];
  if (typeof value !== 'string' || value === '') throw new Error(`${CONFIG_FILE_NAME}: ${where}${key} must be a non-empty string`);
  return value;
}

function extensionsField(fields: Fields, key: string, where: string): string[] {
  const value = fields[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((ext) => typeof ext === 'string' && EXTENSION_PATTERN.test(ext))) {
    throw new Error(`${CONFIG_FILE_NAME}: ${where}${key} must be a non-empty array of lowercase extensions without dots`);
  }
  return value as string[];
}

function relativeSubdir(fields: Fields, key: string, where: string): string {
  const value = stringField(fields, key, where);
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new Error(`${CONFIG_FILE_NAME}: ${where}${key} must be a relative path inside the repo`);
  }
  return value.replace(/\/+$/, '');
}

export function findConfigFile(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILE_NAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`${CONFIG_FILE_NAME} not found from ${startDir} upward`);
    dir = parent;
  }
}

function resolveRuntime(fields: Fields, repoRoot: string): ResolvedRuntime | null {
  const missing = RUNTIME_KEYS.filter((key) => fields[key] === undefined);
  if (missing.length === RUNTIME_KEYS.length) return null;
  if (missing.length > 0) {
    throw new Error(`${CONFIG_FILE_NAME}: runtime store settings are all-or-nothing, missing: ${missing.join(', ')}`);
  }
  const publicRootRelative = relativeSubdir(fields, 'publicRoot', '').split(path.sep).join('/');
  const store = asObject(fields.store, 'store');
  return {
    publicRoot: path.join(repoRoot, publicRootRelative),
    publicRootRelative,
    manifestPath: path.join(repoRoot, relativeSubdir(fields, 'manifest', '')),
    recordPath: path.join(repoRoot, relativeSubdir(fields, 'hydratedRecord', '')),
    layout: { trackedDir: relativeSubdir(fields, 'trackedDir', ''), extensions: extensionsField(fields, 'extensions', '') },
    store: { dirName: relativeSubdir(store, 'dir', 'store.'), machineCache: relativeSubdir(store, 'machineCache', 'store.') },
  };
}

export function resolveConfig(raw: unknown, repoRoot: string): ResolvedConfig {
  const fields = asObject(raw, 'config');
  const runtime = resolveRuntime(fields, repoRoot);
  const publish = fields.publish === undefined ? null : asObject(fields.publish, 'publish');
  const archive = fields.archive === undefined ? null : asObject(fields.archive, 'archive');
  if (!runtime && !archive) throw new Error(`${CONFIG_FILE_NAME}: needs the runtime store settings, an "archive" section, or both`);
  if (publish && !runtime) throw new Error(`${CONFIG_FILE_NAME}: "publish" needs the runtime store settings`);
  return {
    repoRoot,
    runtime,
    publish: publish && runtime && {
      host: stringField(publish, 'host', 'publish.'),
      projectDir: stringField(publish, 'projectDir', 'publish.'),
      storeName: path.basename(runtime.store.dirName),
    },
    archive: archive && {
      remote: stringField(archive, 'remote', 'archive.'),
      settings: {
        root: stringField(archive, 'root', 'archive.'),
        requireMount: stringField(archive, 'requireMount', 'archive.'),
        snapshotPrefix: stringField(archive, 'snapshotPrefix', 'archive.'),
        sourceDir: path.join(repoRoot, relativeSubdir(archive, 'sourceDir', 'archive.')),
        manifestPath: path.join(repoRoot, relativeSubdir(archive, 'manifest', 'archive.')),
        extensions: extensionsField(archive, 'extensions', 'archive.'),
      },
    },
  };
}

export function loadConfig(startDir: string): ResolvedConfig {
  const file = findConfigFile(startDir);
  return resolveConfig(JSON.parse(fs.readFileSync(file, 'utf8')), path.dirname(file));
}
