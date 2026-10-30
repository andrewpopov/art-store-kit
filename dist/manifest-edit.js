"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readHydratedRecord = readHydratedRecord;
exports.writeHydratedRecord = writeHydratedRecord;
exports.hashLocalKeys = hashLocalKeys;
exports.classifyKey = classifyKey;
exports.classifyKeys = classifyKeys;
exports.applyLocalEdits = applyLocalEdits;
exports.normalizeArtKey = normalizeArtKey;
exports.resolveAddKeys = resolveAddKeys;
exports.applyAddRemove = applyAddRemove;
exports.checkLocal = checkLocal;
exports.findTrackedImages = findTrackedImages;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const core_1 = require("./core");
const manifest_1 = require("./manifest");
function readHydratedRecord(file) {
    return node_fs_1.default.existsSync(file) ? JSON.parse(node_fs_1.default.readFileSync(file, 'utf8')) : {};
}
function writeHydratedRecord(file, record) {
    const sorted = Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
    node_fs_1.default.writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
}
function hashLocalKeys(keys, publicRoot) {
    const hashes = new Map();
    for (const key of keys) {
        const file = node_path_1.default.join(publicRoot, key);
        hashes.set(key, node_fs_1.default.existsSync(file) ? (0, core_1.hashFile)(file) : null);
    }
    return hashes;
}
function classifyKey(entry, local, recorded) {
    if (local === null || local === undefined)
        return 'absent';
    if (local === entry)
        return 'in-sync';
    return recorded === local ? 'stale-untouched' : 'local-edit';
}
function classifyKeys(manifest, local, record) {
    const states = new Map();
    for (const [key, entry] of Object.entries(manifest.entries)) {
        states.set(key, classifyKey(entry, local.get(key), record[key]));
    }
    return states;
}
function applyLocalEdits(manifest, local, record, takeLocal = []) {
    const entries = { ...manifest.entries };
    const nextRecord = { ...record };
    const updated = [];
    const conflicts = [];
    for (const key of takeLocal) {
        if (!(key in entries))
            throw new Error(`--take-local: not in manifest: ${key}`);
        if (!local.get(key))
            throw new Error(`--take-local: no local file: ${key}`);
    }
    for (const [key, entry] of Object.entries(manifest.entries)) {
        const hash = local.get(key);
        if (hash === null || hash === undefined)
            continue;
        const recorded = record[key];
        if (takeLocal.includes(key)) {
            if (hash !== entry)
                updated.push(key);
        }
        else if (hash === entry || (recorded !== undefined && recorded !== entry && hash === recorded)) {
            continue;
        }
        else if (recorded !== entry) {
            conflicts.push(key);
            continue;
        }
        else {
            updated.push(key);
        }
        entries[key] = hash;
        nextRecord[key] = hash;
    }
    return { manifest: { ...manifest, entries }, record: nextRecord, updated, conflicts };
}
function normalizeArtKey(arg, space) {
    const relative = node_path_1.default.isAbsolute(arg)
        ? node_path_1.default.relative(space.publicRoot, arg)
        : arg.replace(new RegExp(`^(\\./)?${escapeRegExp(space.publicRootRelative)}/`), '');
    const key = node_path_1.default.posix.normalize(relative.split(node_path_1.default.sep).join('/'));
    if (key !== space.trackedDir && !key.startsWith(`${space.trackedDir}/`)) {
        throw new Error(`Not under ${space.publicRootRelative}/${space.trackedDir}: ${arg}`);
    }
    return key;
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function resolveAddKeys(args, space) {
    const keys = new Set();
    for (const arg of args) {
        const start = normalizeArtKey(arg, space);
        const found = (0, core_1.listFilesUnder)(space.publicRoot, start);
        if (found.length === 0)
            throw new Error(`No files found at ${arg}`);
        for (const key of found)
            if ((0, manifest_1.isArtExtension)(key, space.extensions))
                keys.add(key);
    }
    return [...keys].sort();
}
function applyAddRemove(manifest, added, removeKeys) {
    const entries = { ...manifest.entries };
    const removed = removeKeys.filter((key) => key in entries);
    for (const key of removed)
        delete entries[key];
    const newKeys = [];
    for (const [key, hash] of added) {
        if (key in entries)
            continue;
        newKeys.push(key);
        entries[key] = hash;
    }
    return { manifest: { ...manifest, entries }, added: newKeys, removed };
}
function checkLocal(manifest, local) {
    const result = { missing: [], differs: [] };
    for (const [key, entry] of Object.entries(manifest.entries)) {
        const hash = local.get(key);
        if (hash === null || hash === undefined)
            result.missing.push(key);
        else if (hash !== entry)
            result.differs.push(key);
    }
    return result;
}
function findTrackedImages(trackedFiles, extensions) {
    return trackedFiles.filter((file) => (0, manifest_1.isArtExtension)(file, extensions));
}
