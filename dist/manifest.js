"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ART_HASH_HEX_LENGTH = void 0;
exports.isArtExtension = isArtExtension;
exports.artObjectName = artObjectName;
exports.isArtObjectName = isArtObjectName;
exports.parseArtManifest = parseArtManifest;
exports.ART_HASH_HEX_LENGTH = 32;
const HASH_PATTERN = new RegExp(`^[0-9a-f]{${exports.ART_HASH_HEX_LENGTH}}$`);
function allowedExtension(logicalPath, extensions) {
    const dot = logicalPath.lastIndexOf('.');
    if (dot < 0 || logicalPath.lastIndexOf('/') > dot)
        return null;
    const ext = logicalPath.slice(dot + 1).toLowerCase();
    return extensions.includes(ext) ? ext : null;
}
function isArtExtension(logicalPath, extensions) {
    return allowedExtension(logicalPath, extensions) !== null;
}
function artObjectName(logicalPath, hash, extensions) {
    const ext = allowedExtension(logicalPath, extensions);
    if (!ext)
        throw new Error(`Art path has no allowed extension: ${logicalPath}`);
    return `${hash}.${ext}`;
}
function isArtObjectName(name, extensions) {
    return new RegExp(`^[0-9a-f]{${exports.ART_HASH_HEX_LENGTH}}\\.(${extensions.join('|')})$`).test(name);
}
function parseArtManifest(json, layout) {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        throw new Error('Art manifest must be an object');
    }
    const { version, hash, entries } = json;
    if (version !== 1)
        throw new Error(`Art manifest version must be 1, got ${String(version)}`);
    if (hash !== 'sha256-128')
        throw new Error(`Art manifest hash must be "sha256-128", got ${String(hash)}`);
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
        throw new Error('Art manifest entries must be an object');
    }
    const parsed = {};
    for (const [key, value] of Object.entries(entries)) {
        if (!key.startsWith(`${layout.trackedDir}/`)) {
            throw new Error(`Art manifest key must start with "${layout.trackedDir}/": ${key}`);
        }
        if (key.split('/').includes('..'))
            throw new Error(`Art manifest key must not contain "..": ${key}`);
        if (!allowedExtension(key, layout.extensions))
            throw new Error(`Art manifest key has a disallowed extension: ${key}`);
        if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
            throw new Error(`Art manifest hash for ${key} must be ${exports.ART_HASH_HEX_LENGTH} lowercase hex chars`);
        }
        parsed[key] = value;
    }
    return { version: 1, hash: 'sha256-128', entries: parsed };
}
