"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG_FILE_NAME = void 0;
exports.findConfigFile = findConfigFile;
exports.resolveConfig = resolveConfig;
exports.loadConfig = loadConfig;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
exports.CONFIG_FILE_NAME = 'art-store.config.json';
const EXTENSION_PATTERN = /^[a-z0-9]+$/;
function asObject(value, where) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error(`${exports.CONFIG_FILE_NAME}: ${where} must be an object`);
    return value;
}
function stringField(fields, key, where) {
    const value = fields[key];
    if (typeof value !== 'string' || value === '')
        throw new Error(`${exports.CONFIG_FILE_NAME}: ${where}${key} must be a non-empty string`);
    return value;
}
function extensionsField(fields, key, where) {
    const value = fields[key];
    if (!Array.isArray(value) || value.length === 0 || !value.every((ext) => typeof ext === 'string' && EXTENSION_PATTERN.test(ext))) {
        throw new Error(`${exports.CONFIG_FILE_NAME}: ${where}${key} must be a non-empty array of lowercase extensions without dots`);
    }
    return value;
}
function relativeSubdir(fields, key, where) {
    const value = stringField(fields, key, where);
    if (node_path_1.default.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
        throw new Error(`${exports.CONFIG_FILE_NAME}: ${where}${key} must be a relative path inside the repo`);
    }
    return value.replace(/\/+$/, '');
}
function findConfigFile(startDir) {
    let dir = node_path_1.default.resolve(startDir);
    for (;;) {
        const candidate = node_path_1.default.join(dir, exports.CONFIG_FILE_NAME);
        if (node_fs_1.default.existsSync(candidate))
            return candidate;
        const parent = node_path_1.default.dirname(dir);
        if (parent === dir)
            throw new Error(`${exports.CONFIG_FILE_NAME} not found from ${startDir} upward`);
        dir = parent;
    }
}
function resolveConfig(raw, repoRoot) {
    const fields = asObject(raw, 'config');
    const publicRootRelative = relativeSubdir(fields, 'publicRoot', '').split(node_path_1.default.sep).join('/');
    const store = asObject(fields.store, 'store');
    const storeLocation = {
        dirName: relativeSubdir(store, 'dir', 'store.'),
        machineCache: relativeSubdir(store, 'machineCache', 'store.'),
    };
    const layout = {
        trackedDir: relativeSubdir(fields, 'trackedDir', ''),
        extensions: extensionsField(fields, 'extensions', ''),
    };
    const publish = fields.publish === undefined ? null : asObject(fields.publish, 'publish');
    const archive = fields.archive === undefined ? null : asObject(fields.archive, 'archive');
    return {
        repoRoot,
        publicRoot: node_path_1.default.join(repoRoot, publicRootRelative),
        publicRootRelative,
        manifestPath: node_path_1.default.join(repoRoot, relativeSubdir(fields, 'manifest', '')),
        recordPath: node_path_1.default.join(repoRoot, relativeSubdir(fields, 'hydratedRecord', '')),
        layout,
        store: storeLocation,
        publish: publish && {
            host: stringField(publish, 'host', 'publish.'),
            projectDir: stringField(publish, 'projectDir', 'publish.'),
            storeName: node_path_1.default.basename(storeLocation.dirName),
        },
        archive: archive && {
            remote: stringField(archive, 'remote', 'archive.'),
            settings: {
                root: stringField(archive, 'root', 'archive.'),
                requireMount: stringField(archive, 'requireMount', 'archive.'),
                snapshotPrefix: stringField(archive, 'snapshotPrefix', 'archive.'),
                sourceDir: node_path_1.default.join(repoRoot, relativeSubdir(archive, 'sourceDir', 'archive.')),
                manifestPath: node_path_1.default.join(repoRoot, relativeSubdir(archive, 'manifest', 'archive.')),
                extensions: extensionsField(archive, 'extensions', 'archive.'),
            },
        },
    };
}
function loadConfig(startDir) {
    const file = findConfigFile(startDir);
    return resolveConfig(JSON.parse(node_fs_1.default.readFileSync(file, 'utf8')), node_path_1.default.dirname(file));
}
