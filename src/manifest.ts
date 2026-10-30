export const ART_HASH_HEX_LENGTH = 32;

export type ArtManifest = {
  version: 1;
  hash: 'sha256-128';
  entries: Record<string, string>;
};

export type ArtLayout = {
  trackedDir: string;
  extensions: readonly string[];
};

const HASH_PATTERN = new RegExp(`^[0-9a-f]{${ART_HASH_HEX_LENGTH}}$`);

function allowedExtension(logicalPath: string, extensions: readonly string[]): string | null {
  const dot = logicalPath.lastIndexOf('.');
  if (dot < 0 || logicalPath.lastIndexOf('/') > dot) return null;
  const ext = logicalPath.slice(dot + 1).toLowerCase();
  return extensions.includes(ext) ? ext : null;
}

export function isArtExtension(logicalPath: string, extensions: readonly string[]): boolean {
  return allowedExtension(logicalPath, extensions) !== null;
}

export function artObjectName(logicalPath: string, hash: string, extensions: readonly string[]): string {
  const ext = allowedExtension(logicalPath, extensions);
  if (!ext) throw new Error(`Art path has no allowed extension: ${logicalPath}`);
  return `${hash}.${ext}`;
}

export function isArtObjectName(name: string, extensions: readonly string[]): boolean {
  return new RegExp(`^[0-9a-f]{${ART_HASH_HEX_LENGTH}}\\.(${extensions.join('|')})$`).test(name);
}

export function parseArtManifest(json: unknown, layout: ArtLayout): ArtManifest {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Art manifest must be an object');
  }
  const { version, hash, entries } = json as Record<string, unknown>;
  if (version !== 1) throw new Error(`Art manifest version must be 1, got ${String(version)}`);
  if (hash !== 'sha256-128') throw new Error(`Art manifest hash must be "sha256-128", got ${String(hash)}`);
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    throw new Error('Art manifest entries must be an object');
  }
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!key.startsWith(`${layout.trackedDir}/`)) {
      throw new Error(`Art manifest key must start with "${layout.trackedDir}/": ${key}`);
    }
    if (key.split('/').includes('..')) throw new Error(`Art manifest key must not contain "..": ${key}`);
    if (!allowedExtension(key, layout.extensions)) throw new Error(`Art manifest key has a disallowed extension: ${key}`);
    if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
      throw new Error(`Art manifest hash for ${key} must be ${ART_HASH_HEX_LENGTH} lowercase hex chars`);
    }
    parsed[key] = value;
  }
  return { version: 1, hash: 'sha256-128', entries: parsed };
}
