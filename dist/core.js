"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LISTING_CAP = void 0;
exports.hashBytes = hashBytes;
exports.buildManifest = buildManifest;
exports.serializeManifest = serializeManifest;
exports.formatCapped = formatCapped;
exports.objectNames = objectNames;
exports.hashFile = hashFile;
exports.hashOfObjectName = hashOfObjectName;
exports.storeObject = storeObject;
exports.materialize = materialize;
exports.verifyStore = verifyStore;
exports.remoteStoreDir = remoteStoreDir;
exports.buildSendCommand = buildSendCommand;
exports.buildFetchCommand = buildFetchCommand;
exports.buildVerifyCommand = buildVerifyCommand;
exports.buildMkdirCommand = buildMkdirCommand;
exports.parseItemizedNames = parseItemizedNames;
exports.listFilesUnder = listFilesUnder;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const manifest_1 = require("./manifest");
exports.LISTING_CAP = 20;
const RSYNC_CHMOD = '--chmod=F644,D755';
function hashBytes(bytes) {
    return (0, node_crypto_1.createHash)('sha256').update(bytes).digest('hex').slice(0, manifest_1.ART_HASH_HEX_LENGTH);
}
function buildManifest(keys, readBytes, extensions) {
    const entries = {};
    for (const key of [...keys].sort()) {
        if ((0, manifest_1.isArtExtension)(key, extensions))
            entries[key] = hashBytes(readBytes(key));
    }
    return { version: 1, hash: 'sha256-128', entries };
}
function serializeManifest(manifest) {
    const lines = Object.keys(manifest.entries)
        .sort()
        .map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(manifest.entries[key])}`);
    const entries = lines.length ? `{\n${lines.join(',\n')}\n  }` : '{}';
    return `{\n  "version": 1,\n  "hash": "sha256-128",\n  "entries": ${entries}\n}\n`;
}
function formatCapped(label, items, cap = exports.LISTING_CAP) {
    if (items.length === 0)
        return [];
    const shown = items.slice(0, cap).map((item) => `  ${label}: ${item}`);
    const hidden = items.length - shown.length;
    return [...shown, ...(hidden > 0 ? [`  ... and ${hidden} more ${label}`] : []), `${label} total: ${items.length}`];
}
function objectNames(manifest, extensions) {
    const names = new Map();
    for (const [key, hash] of Object.entries(manifest.entries)) {
        const name = (0, manifest_1.artObjectName)(key, hash, extensions);
        if (!names.has(name))
            names.set(name, key);
    }
    return names;
}
function hashFile(file) {
    return hashBytes(node_fs_1.default.readFileSync(file));
}
function hashOfObjectName(name) {
    return name.slice(0, manifest_1.ART_HASH_HEX_LENGTH);
}
function storeObject(source, storeDir, name) {
    node_fs_1.default.mkdirSync(storeDir, { recursive: true });
    const tmp = node_path_1.default.join(storeDir, `.tmp-${process.pid}-${name}`);
    const dest = node_path_1.default.join(storeDir, name);
    node_fs_1.default.copyFileSync(source, tmp, node_fs_1.default.constants.COPYFILE_FICLONE);
    try {
        if (hashFile(tmp) !== hashOfObjectName(name))
            return 'changed';
        node_fs_1.default.linkSync(tmp, dest);
        return 'created';
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        if (hashFile(dest) === hashOfObjectName(name))
            return 'present';
        node_fs_1.default.renameSync(tmp, dest);
        return 'repaired';
    }
    finally {
        node_fs_1.default.rmSync(tmp, { force: true });
    }
}
function materialize(manifest, publicRoot, storeDir, extensions) {
    const result = { created: 0, present: 0, repaired: [], corrupt: [], missingSources: [], changedSources: [] };
    node_fs_1.default.mkdirSync(storeDir, { recursive: true });
    for (const [name, key] of objectNames(manifest, extensions)) {
        const dest = node_path_1.default.join(storeDir, name);
        const exists = node_fs_1.default.existsSync(dest);
        if (exists && hashFile(dest) === hashOfObjectName(name)) {
            result.present += 1;
            continue;
        }
        const source = node_path_1.default.join(publicRoot, key);
        if (!node_fs_1.default.existsSync(source)) {
            (exists ? result.corrupt : result.missingSources).push(exists ? name : key);
            continue;
        }
        const stored = storeObject(source, storeDir, name);
        if (stored === 'changed')
            (exists ? result.corrupt : result.changedSources).push(exists ? name : key);
        else if (stored === 'repaired')
            result.repaired.push(name);
        else if (stored === 'created')
            result.created += 1;
        else
            result.present += 1;
    }
    return result;
}
function verifyStore(manifest, storeDir, extensions) {
    const problems = { missing: [], corrupt: [], checked: 0 };
    for (const name of objectNames(manifest, extensions).keys()) {
        problems.checked += 1;
        const file = node_path_1.default.join(storeDir, name);
        if (!node_fs_1.default.existsSync(file))
            problems.missing.push(name);
        else if (hashFile(file) !== hashOfObjectName(name))
            problems.corrupt.push(name);
    }
    return problems;
}
function remoteStoreDir(target) {
    return `${target.projectDir.replace(/\/+$/, '')}/${target.storeName}`;
}
function rsyncDestination(target) {
    return `${target.host}:${remoteStoreDir(target)}/`;
}
function namesToStdin(names) {
    return names.map((name) => `${name}\n`).join('');
}
function buildSendCommand(storeDir, target, names, repair = false) {
    const flags = repair ? ['-rt', '--checksum'] : ['-rt', '--ignore-existing'];
    return {
        args: [...flags, RSYNC_CHMOD, '--files-from=-', `${storeDir}/`, rsyncDestination(target)],
        stdin: namesToStdin(names),
    };
}
function buildFetchCommand(storeDir, target, names, repair = false) {
    return {
        args: ['-r', repair ? '--checksum' : '--ignore-existing', '--files-from=-', rsyncDestination(target), `${storeDir}/`],
        stdin: namesToStdin(names),
    };
}
function buildVerifyCommand(storeDir, target, names) {
    return {
        args: ['-rn', '--checksum', '--itemize-changes', '--files-from=-', `${storeDir}/`, rsyncDestination(target)],
        stdin: namesToStdin(names),
    };
}
function buildMkdirCommand(target) {
    return [target.host, 'mkdir', '-p', remoteStoreDir(target)];
}
function parseItemizedNames(output) {
    return output
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => line.replace(/^\S+\s+/, ''));
}
function listFilesUnder(publicRoot, startKey) {
    const keys = [];
    const walk = (relativeDir) => {
        for (const entry of node_fs_1.default.readdirSync(node_path_1.default.join(publicRoot, relativeDir), { withFileTypes: true })) {
            const relative = `${relativeDir}/${entry.name}`;
            if (entry.isDirectory())
                walk(relative);
            else if (entry.isFile())
                keys.push(relative);
        }
    };
    const start = node_path_1.default.join(publicRoot, startKey);
    if (node_fs_1.default.statSync(start, { throwIfNoEntry: false })?.isDirectory())
        walk(startKey);
    else if (node_fs_1.default.statSync(start, { throwIfNoEntry: false })?.isFile())
        keys.push(startKey);
    return keys;
}
