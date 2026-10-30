"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sha256File = sha256File;
exports.archiveObjectName = archiveObjectName;
exports.scanArchiveSource = scanArchiveSource;
exports.serializeArchiveManifest = serializeArchiveManifest;
exports.parseArchiveManifest = parseArchiveManifest;
exports.checksumLines = checksumLines;
exports.snapshotStamp = snapshotStamp;
exports.archive = archive;
exports.archivePull = archivePull;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const ARCHIVE_LINE = /^([0-9a-f]{64}) {2}(.+)$/;
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function sha256File(file) {
    return (0, node_crypto_1.createHash)('sha256').update(node_fs_1.default.readFileSync(file)).digest('hex');
}
function archiveObjectName(entry) {
    return `${entry.sha}${node_path_1.default.extname(entry.path).toLowerCase()}`;
}
function scanArchiveSource(sourceDir, extensions) {
    const paths = [];
    const walk = (relativeDir) => {
        for (const dirent of node_fs_1.default.readdirSync(node_path_1.default.join(sourceDir, relativeDir), { withFileTypes: true })) {
            const relative = relativeDir === '' ? dirent.name : `${relativeDir}/${dirent.name}`;
            if (dirent.isDirectory())
                walk(relative);
            else if (dirent.isFile() && extensions.some((ext) => relative.endsWith(`.${ext}`)))
                paths.push(relative);
        }
    };
    walk('');
    return paths.sort(byBytes).map((relative) => ({ sha: sha256File(node_path_1.default.join(sourceDir, relative)), path: relative }));
}
function serializeArchiveManifest(entries) {
    return entries.map((entry) => `${entry.sha}  ${entry.path}\n`).join('');
}
function parseArchiveManifest(text) {
    return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
        const match = ARCHIVE_LINE.exec(line);
        if (!match)
            throw new Error(`malformed archive manifest line: ${line}`);
        const segments = match[2].split('/');
        if (node_path_1.default.isAbsolute(match[2]) || segments.includes('..'))
            throw new Error(`unsafe archive manifest path: ${match[2]}`);
        return { sha: match[1], path: match[2] };
    });
}
function checksumLines(entries) {
    const lines = new Set(entries.map((entry) => `${entry.sha}  ${archiveObjectName(entry)}`));
    return [...lines].sort().map((line) => `${line}\n`).join('');
}
function snapshotStamp(now) {
    return `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}
function archive(settings, remote, deps = {}) {
    const entries = scanArchiveSource(settings.sourceDir, settings.extensions);
    if (entries.length === 0) {
        throw new Error(`no ${settings.extensions.map((ext) => `*.${ext}`).join(', ')} files found under ${settings.sourceDir}`);
    }
    if (!remote.isMountpoint(settings.requireMount)) {
        throw new Error(`${remote.label}:${settings.requireMount} is not a mounted filesystem; refusing`);
    }
    const objectsDir = `${settings.root}/objects`;
    remote.ensureDirs([objectsDir, `${settings.root}/manifests`]);
    for (const entry of entries) {
        remote.upload(node_path_1.default.join(settings.sourceDir, entry.path), `${objectsDir}/${archiveObjectName(entry)}`);
    }
    const verification = remote.verifyObjects(objectsDir, checksumLines(entries));
    if (!verification.ok) {
        throw new Error(`verification on ${remote.label} failed; see FAILED lines below\n${verification.output}`.trimEnd());
    }
    const manifest = serializeArchiveManifest(entries);
    node_fs_1.default.writeFileSync(settings.manifestPath, manifest);
    const snapshot = `${settings.snapshotPrefix}-${snapshotStamp((deps.now ?? (() => new Date()))())}.sha256`;
    remote.writeNoClobber(`${settings.root}/manifests/${snapshot}`, manifest);
    deps.log?.(`archived and verified ${entries.length} files on ${remote.label}:${settings.root}`);
    return { count: entries.length, snapshot };
}
function archivePull(settings, remote, prefix = '') {
    if (!node_fs_1.default.existsSync(settings.manifestPath))
        throw new Error(`missing ${settings.manifestPath}`);
    const selected = parseArchiveManifest(node_fs_1.default.readFileSync(settings.manifestPath, 'utf8')).filter((entry) => entry.path.startsWith(prefix));
    if (selected.length === 0)
        throw new Error(`no manifest entries match prefix '${prefix}'`);
    let fetched = 0;
    for (const entry of selected) {
        const local = node_path_1.default.join(settings.sourceDir, entry.path);
        if (node_fs_1.default.existsSync(local) && sha256File(local) === entry.sha)
            continue;
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(local), { recursive: true });
        remote.download(`${settings.root}/objects/${archiveObjectName(entry)}`, local);
        fetched += 1;
    }
    const failed = selected
        .filter((entry) => {
        const local = node_path_1.default.join(settings.sourceDir, entry.path);
        return !node_fs_1.default.existsSync(local) || sha256File(local) !== entry.sha;
    })
        .map((entry) => entry.path);
    return { selected: selected.length, fetched, failed };
}
