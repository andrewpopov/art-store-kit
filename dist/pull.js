"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.needsHydration = needsHydration;
exports.planFetch = planFetch;
exports.pull = pull;
exports.reportPull = reportPull;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const manifest_1 = require("./manifest");
const core_1 = require("./core");
const manifest_edit_1 = require("./manifest-edit");
const objectNameOf = (manifest, key, extensions) => (0, manifest_1.artObjectName)(key, manifest.entries[key], extensions);
function needsHydration(state, discardLocal) {
    return state === 'absent' || state === 'stale-untouched' || (state === 'local-edit' && discardLocal);
}
function planFetch(manifest, states, discardLocal, available, extensions) {
    const missing = new Set();
    for (const [key, state] of states) {
        const name = objectNameOf(manifest, key, extensions);
        if (needsHydration(state, discardLocal) && !available.has(name))
            missing.add(name);
    }
    return [...missing].sort();
}
function availableObjects(manifest, storeDir, states, extensions) {
    const available = new Set();
    for (const [key, state] of states) {
        const name = objectNameOf(manifest, key, extensions);
        if (state === 'in-sync' || node_fs_1.default.existsSync(node_path_1.default.join(storeDir, name)))
            available.add(name);
    }
    return available;
}
function isIntact(storeDir, name) {
    const file = node_path_1.default.join(storeDir, name);
    return node_fs_1.default.existsSync(file) && (0, core_1.hashFile)(file) === (0, core_1.hashOfObjectName)(name);
}
const LINK_FALLBACK_CODES = new Set(['EXDEV', 'EPERM']);
function linkOrCopy(source, tmp) {
    try {
        node_fs_1.default.linkSync(source, tmp);
    }
    catch (error) {
        if (!LINK_FALLBACK_CODES.has(error.code ?? ''))
            throw error;
        node_fs_1.default.copyFileSync(source, tmp, node_fs_1.default.constants.COPYFILE_FICLONE);
    }
}
function writeAtomically(source, dest, link) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    node_fs_1.default.rmSync(tmp, { force: true });
    if (link)
        linkOrCopy(source, tmp);
    else
        node_fs_1.default.copyFileSync(source, tmp, node_fs_1.default.constants.COPYFILE_FICLONE);
    node_fs_1.default.renameSync(tmp, dest);
}
function adoptInSync(manifest, states, options) {
    const adopted = [];
    const repaired = [];
    for (const [key, state] of states) {
        if (state !== 'in-sync')
            continue;
        const name = objectNameOf(manifest, key, options.extensions);
        if (!options.dryRun && (0, core_1.storeObject)(node_path_1.default.join(options.publicRoot, key), options.storeDir, name) === 'repaired') {
            repaired.push(name);
        }
        if (options.record[key] !== manifest.entries[key])
            adopted.push(key);
    }
    return { adopted, repaired };
}
function fetchObjects(names, options) {
    if (names.length === 0 || options.dryRun)
        return { corrupt: [], failure: null };
    node_fs_1.default.mkdirSync(options.storeDir, { recursive: true }); // rsync creates only the last path segment
    try {
        options.runner((0, core_1.buildFetchCommand)(options.storeDir, options.target, names));
    }
    catch (error) {
        return { corrupt: [], failure: error instanceof Error ? error.message : String(error) };
    }
    const corrupt = [];
    for (const name of names) {
        const file = node_path_1.default.join(options.storeDir, name);
        if (node_fs_1.default.existsSync(file) && (0, core_1.hashFile)(file) !== (0, core_1.hashOfObjectName)(name)) {
            node_fs_1.default.unlinkSync(file);
            corrupt.push(name);
        }
    }
    return { corrupt, failure: null };
}
function verifyBeforeHydrate(names, options) {
    const bad = names.filter((name) => node_fs_1.default.existsSync(node_path_1.default.join(options.storeDir, name)) && !isIntact(options.storeDir, name));
    if (bad.length === 0 || !options.repair)
        return bad.map((name) => `corrupt object (use --repair): ${name}`);
    options.runner((0, core_1.buildFetchCommand)(options.storeDir, options.target, bad, true));
    return bad.filter((name) => !isIntact(options.storeDir, name)).map((name) => `corrupt object after repair: ${name}`);
}
function pull(manifest, options) {
    const discardLocal = options.discardLocal ?? false;
    const record = { ...options.record };
    const result = { exitCode: 0, adopted: [], repaired: [], fetched: [], hydrated: [], localEditsKept: [], problems: [], record };
    const local = (0, manifest_edit_1.hashLocalKeys)(Object.keys(manifest.entries), options.publicRoot);
    const states = (0, manifest_edit_1.classifyKeys)(manifest, local, record);
    ({ adopted: result.adopted, repaired: result.repaired } = adoptInSync(manifest, states, options));
    for (const key of result.adopted)
        record[key] = manifest.entries[key];
    const toFetch = planFetch(manifest, states, discardLocal, availableObjects(manifest, options.storeDir, states, options.extensions), options.extensions);
    const fetch = fetchObjects(toFetch, options);
    result.fetched = toFetch.filter((name) => !fetch.corrupt.includes(name));
    if (fetch.failure)
        result.problems.push(`fetch failed: ${fetch.failure}`);
    result.problems.push(...fetch.corrupt.map((name) => `corrupt fetched object deleted: ${name}`));
    const hydrateKeys = [...states].filter(([, state]) => needsHydration(state, discardLocal)).map(([key]) => key);
    result.localEditsKept = [...states].filter(([, s]) => s === 'local-edit' && !discardLocal).map(([key]) => key);
    if (options.dryRun) {
        result.hydrated = hydrateKeys;
        return result;
    }
    const names = [...new Set(hydrateKeys.map((key) => objectNameOf(manifest, key, options.extensions)))];
    if (result.problems.length === 0) {
        result.problems.push(...names.filter((name) => !node_fs_1.default.existsSync(node_path_1.default.join(options.storeDir, name))).map((name) => `object missing after fetch: ${name}`), ...verifyBeforeHydrate(names, options));
    }
    if (result.problems.length > 0) {
        result.exitCode = 1;
        return result;
    }
    for (const key of hydrateKeys) {
        const dest = node_path_1.default.join(options.publicRoot, key);
        const current = node_fs_1.default.existsSync(dest) ? (0, core_1.hashFile)(dest) : null;
        if (!discardLocal && current !== (local.get(key) ?? null)) {
            result.localEditsKept.push(key);
            continue;
        }
        writeAtomically(node_path_1.default.join(options.storeDir, objectNameOf(manifest, key, options.extensions)), dest, options.linkHydrated ?? false);
        record[key] = manifest.entries[key];
        result.hydrated.push(key);
    }
    return result;
}
function reportPull(result, dryRun) {
    const prefix = dryRun ? 'dry run: would ' : '';
    return [
        ...(0, core_1.formatCapped)('repaired from local', result.repaired),
        ...(0, core_1.formatCapped)('local edit kept', result.localEditsKept),
        ...result.problems.map((problem) => `error: ${problem}`),
        `pull: ${prefix}adopt ${result.adopted.length}, fetch ${result.fetched.length} objects, hydrate ${result.hydrated.length}, local edits kept ${result.localEditsKept.length}`,
    ];
}
