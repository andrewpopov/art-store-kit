"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const archive_1 = require("./archive");
const archive_ssh_1 = require("./archive-ssh");
const config_1 = require("./config");
const core_1 = require("./core");
const manifest_1 = require("./manifest");
const manifest_edit_1 = require("./manifest-edit");
const pull_1 = require("./pull");
const store_location_1 = require("./store-location");
const VALUE_FLAGS = new Set(['--store', '--manifest', '--public-root', '--hydrated-record']);
const LIST_FLAGS = new Set(['--add', '--remove', '--take-local']);
const BOOLEAN_FLAGS = new Set(['--check', '--repair', '--dry-run', '--discard-local']);
const POSITIONAL_COMMANDS = new Set(['archive-pull']);
const USAGE = 'usage: art-store <manifest [--check] [--add paths] [--remove keys] [--take-local keys] | pull [--repair] [--discard-local] [--dry-run] | check-untracked | materialize | verify-store | publish [--repair] [--dry-run] | archive | archive-pull [prefix]> [--store dir] [--manifest file] [--public-root dir] [--hydrated-record file]';
function parseArgs(argv) {
    const [command = '', ...rest] = argv;
    const options = { command, flags: new Set(), values: new Map(), lists: new Map(), positionals: [] };
    let list = null;
    for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (VALUE_FLAGS.has(arg)) {
            const value = rest[i + 1];
            if (value === undefined)
                throw new Error(`${arg} needs a value`);
            options.values.set(arg, node_path_1.default.resolve(value));
            i += 1;
            list = null;
        }
        else if (LIST_FLAGS.has(arg)) {
            list = options.lists.get(arg) ?? [];
            options.lists.set(arg, list);
        }
        else if (BOOLEAN_FLAGS.has(arg)) {
            options.flags.add(arg);
            list = null;
        }
        else if (list && !arg.startsWith('--')) {
            list.push(arg);
        }
        else if (POSITIONAL_COMMANDS.has(command) && !arg.startsWith('--')) {
            options.positionals.push(arg);
        }
        else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}
function buildContext(config, options) {
    const publicRoot = options.values.get('--public-root') ?? config.publicRoot;
    return {
        config,
        options,
        publicRoot,
        manifestPath: options.values.get('--manifest') ?? config.manifestPath,
        recordPath: options.values.get('--hydrated-record') ?? config.recordPath,
        storeDir: options.values.get('--store') ?? (0, store_location_1.resolveArtStoreDir)(config.repoRoot, config.store),
        keySpace: { ...config.layout, publicRoot, publicRootRelative: config.publicRootRelative },
    };
}
function readManifest(context) {
    return (0, manifest_1.parseArtManifest)(JSON.parse(node_fs_1.default.readFileSync(context.manifestPath, 'utf8')), context.config.layout);
}
function requirePublishTarget(config) {
    if (!config.publish)
        throw new Error('art-store.config.json needs a "publish" section with host and projectDir');
    return config.publish;
}
function printLines(lines) {
    for (const line of lines)
        console.log(line);
}
function printProblems(lines) {
    for (const line of lines)
        console.error(line);
}
function describeCommand(binary, command) {
    const files = command.stdin.split('\n').filter(Boolean).length;
    return `${[binary, ...command.args].join(' ')}   (stdin: ${files} file names)`;
}
function runRsync(command) {
    return (0, node_child_process_1.execFileSync)('rsync', command.args, { input: command.stdin, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function runMaterialize(context, manifest) {
    const result = (0, core_1.materialize)(manifest, context.publicRoot, context.storeDir, context.config.layout.extensions);
    console.log(`materialize: ${result.created} created, ${result.present} already present (${context.storeDir})`);
    const problems = [
        ...(0, core_1.formatCapped)('corrupt object', result.corrupt),
        ...(0, core_1.formatCapped)('missing source', result.missingSources),
        ...(0, core_1.formatCapped)('source changed since manifest', result.changedSources),
    ];
    printLines((0, core_1.formatCapped)('repaired from local', result.repaired));
    printProblems(problems);
    return problems.length === 0;
}
function publish(context, manifest) {
    const target = requirePublishTarget(context.config);
    const { storeDir } = context;
    const repair = context.options.flags.has('--repair');
    const names = [...(0, core_1.objectNames)(manifest, context.config.layout.extensions).keys()].sort();
    if (context.options.flags.has('--dry-run')) {
        console.log(`dry run: ${names.length} objects from ${storeDir}`);
        console.log(describeCommand('ssh', { args: (0, core_1.buildMkdirCommand)(target), stdin: '' }));
        console.log(describeCommand('rsync', (0, core_1.buildSendCommand)(storeDir, target, names)));
        console.log(describeCommand('rsync', (0, core_1.buildVerifyCommand)(storeDir, target, names)));
        if (repair)
            console.log(describeCommand('rsync', (0, core_1.buildSendCommand)(storeDir, target, ['<mismatched>'], true)));
        return true;
    }
    if (!runMaterialize(context, manifest))
        return false;
    (0, node_child_process_1.execFileSync)('ssh', (0, core_1.buildMkdirCommand)(target), { stdio: 'inherit' });
    runRsync((0, core_1.buildSendCommand)(storeDir, target, names));
    let mismatched = (0, core_1.parseItemizedNames)(runRsync((0, core_1.buildVerifyCommand)(storeDir, target, names)));
    if (mismatched.length > 0 && repair) {
        runRsync((0, core_1.buildSendCommand)(storeDir, target, mismatched, true));
        mismatched = (0, core_1.parseItemizedNames)(runRsync((0, core_1.buildVerifyCommand)(storeDir, target, names)));
    }
    if (mismatched.length > 0) {
        printProblems((0, core_1.formatCapped)('remote mismatch', mismatched));
        return false;
    }
    console.log(`publish: ${names.length} objects on ${target.host}:${(0, core_1.remoteStoreDir)(target)} match local bytes`);
    return true;
}
function runManifestCommand(context) {
    const { options, publicRoot, manifestPath, recordPath } = context;
    const manifest = readManifest(context);
    const local = (0, manifest_edit_1.hashLocalKeys)(Object.keys(manifest.entries), publicRoot);
    if (options.flags.has('--check')) {
        const { missing, differs } = (0, manifest_edit_1.checkLocal)(manifest, local);
        const problems = [
            ...(0, core_1.formatCapped)('missing locally (run art-store pull)', missing),
            ...(0, core_1.formatCapped)('differs from manifest', differs),
        ];
        if (problems.length > 0) {
            printProblems(problems);
            return 1;
        }
        console.log(`manifest OK: ${Object.keys(manifest.entries).length} entries match local files`);
        return 0;
    }
    const record = (0, manifest_edit_1.readHydratedRecord)(recordPath);
    const takeLocal = (options.lists.get('--take-local') ?? []).map((arg) => (0, manifest_edit_1.normalizeArtKey)(arg, context.keySpace));
    const edits = (0, manifest_edit_1.applyLocalEdits)(manifest, local, record, takeLocal);
    const addKeys = (0, manifest_edit_1.resolveAddKeys)(options.lists.get('--add') ?? [], context.keySpace);
    const addedHashes = new Map(addKeys.filter((key) => !(key in edits.manifest.entries)).map((key) => [key, (0, core_1.hashFile)(node_path_1.default.join(publicRoot, key))]));
    const changes = (0, manifest_edit_1.applyAddRemove)(edits.manifest, addedHashes, options.lists.get('--remove') ?? []);
    const nextRecord = edits.record;
    for (const key of changes.added)
        nextRecord[key] = changes.manifest.entries[key];
    for (const key of changes.removed)
        delete nextRecord[key];
    node_fs_1.default.writeFileSync(manifestPath, (0, core_1.serializeManifest)(changes.manifest));
    (0, manifest_edit_1.writeHydratedRecord)(recordPath, nextRecord);
    console.log(`manifest: ${Object.keys(changes.manifest.entries).length} entries (${edits.updated.length} updated, ${changes.added.length} added, ${changes.removed.length} removed) -> ${manifestPath}`);
    printLines([
        ...(0, core_1.formatCapped)('updated', edits.updated),
        ...(0, core_1.formatCapped)('added', changes.added),
        ...(0, core_1.formatCapped)('removed', changes.removed),
    ]);
    if (edits.conflicts.length === 0)
        return 0;
    printProblems([
        ...(0, core_1.formatCapped)('conflict', edits.conflicts),
        'resolve: art-store manifest --take-local <keys> (accept local bytes) or art-store pull --discard-local (accept the manifest)',
    ]);
    return 1;
}
function runPull(context) {
    const { options } = context;
    const dryRun = options.flags.has('--dry-run');
    const result = (0, pull_1.pull)(readManifest(context), {
        publicRoot: context.publicRoot,
        storeDir: context.storeDir,
        target: requirePublishTarget(context.config),
        extensions: context.config.layout.extensions,
        record: (0, manifest_edit_1.readHydratedRecord)(context.recordPath),
        runner: (command) => {
            runRsync(command);
        },
        repair: options.flags.has('--repair'),
        discardLocal: options.flags.has('--discard-local'),
        dryRun,
        linkHydrated: (0, store_location_1.isLaneSnapshot)(context.config.repoRoot),
    });
    if (!dryRun)
        (0, manifest_edit_1.writeHydratedRecord)(context.recordPath, result.record);
    for (const line of (0, pull_1.reportPull)(result, dryRun))
        (line.startsWith('error:') ? console.error : console.log)(line);
    return result.exitCode;
}
function runCheckUntracked(context) {
    const { config } = context;
    const out = (0, node_child_process_1.execFileSync)('git', ['ls-files', '-z', '--', `${config.publicRootRelative}/${config.layout.trackedDir}`], {
        cwd: config.repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    const tracked = (0, manifest_edit_1.findTrackedImages)(out.split('\0').filter(Boolean), config.layout.extensions);
    if (tracked.length === 0) {
        console.log('check-untracked OK: no art images are tracked');
        return 0;
    }
    printProblems((0, core_1.formatCapped)('tracked image', tracked));
    console.error('fix: git rm --cached <paths> && art-store manifest --add <paths> && art-store publish');
    return 1;
}
function runVerifyStore(context) {
    const result = (0, core_1.verifyStore)(readManifest(context), context.storeDir, context.config.layout.extensions);
    const problems = [...(0, core_1.formatCapped)('missing object', result.missing), ...(0, core_1.formatCapped)('corrupt object', result.corrupt)];
    if (problems.length > 0) {
        printProblems(problems);
        return 1;
    }
    console.log(`verify-store OK: ${result.checked} objects in ${context.storeDir}`);
    return 0;
}
function withArchiveRemote(config, action) {
    if (!config.archive)
        throw new Error('art-store.config.json needs an "archive" section');
    const remote = (0, archive_ssh_1.createSshArchiveRemote)(config.archive.remote);
    try {
        return action(config.archive.settings, remote);
    }
    finally {
        remote.close();
    }
}
function runArchive(context) {
    withArchiveRemote(context.config, (settings, remote) => (0, archive_1.archive)(settings, remote, { log: console.log }));
    return 0;
}
function runArchivePull(context) {
    const prefix = context.options.positionals[0] ?? '';
    const result = withArchiveRemote(context.config, (settings, remote) => (0, archive_1.archivePull)(settings, remote, prefix));
    if (result.failed.length > 0) {
        printProblems(result.failed.map((failedPath) => `${failedPath}: FAILED`));
        console.error(`archive-pull: ${result.failed.length} of ${result.selected} files do not match the manifest`);
        return 1;
    }
    console.log(`archive-pull: ${result.selected} files verified (${result.fetched} fetched)`);
    return 0;
}
function main(argv, cwd = process.cwd()) {
    const options = parseArgs(argv);
    const commands = {
        manifest: runManifestCommand,
        pull: runPull,
        'check-untracked': runCheckUntracked,
        materialize: (context) => (runMaterialize(context, readManifest(context)) ? 0 : 1),
        'verify-store': runVerifyStore,
        publish: (context) => (publish(context, readManifest(context)) ? 0 : 1),
        archive: runArchive,
        'archive-pull': runArchivePull,
    };
    const run = commands[options.command];
    if (!run) {
        console.error(USAGE);
        return 1;
    }
    return run(buildContext((0, config_1.loadConfig)(cwd), options));
}
