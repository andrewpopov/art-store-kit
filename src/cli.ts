import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { archive, archivePull, type ArchiveRemote, type ArchiveSettings } from './archive';
import { createSshArchiveRemote } from './archive-ssh';
import { CONFIG_FILE_NAME, loadConfig, type ResolvedConfig, type ResolvedRuntime } from './config';
import {
  buildMkdirCommand,
  buildSendCommand,
  buildVerifyCommand,
  formatCapped,
  hashFile,
  materialize,
  objectNames,
  parseItemizedNames,
  remoteStoreDir,
  serializeManifest,
  verifyStore,
  type RemoteStoreTarget,
  type RsyncCommand,
} from './core';
import { parseArtManifest, type ArtManifest } from './manifest';
import {
  applyAddRemove,
  applyLocalEdits,
  checkLocal,
  findTrackedImages,
  hashLocalKeys,
  normalizeArtKey,
  readHydratedRecord,
  resolveAddKeys,
  writeHydratedRecord,
  type KeySpace,
} from './manifest-edit';
import { pull, reportPull } from './pull';
import { isLaneSnapshot, resolveArtStoreDir } from './store-location';

type CliOptions = {
  command: string;
  flags: Set<string>;
  values: Map<string, string>;
  lists: Map<string, string[]>;
  positionals: string[];
};

const VALUE_FLAGS = new Set(['--store', '--manifest', '--public-root', '--hydrated-record']);
const LIST_FLAGS = new Set(['--add', '--remove', '--take-local']);
const BOOLEAN_FLAGS = new Set(['--check', '--repair', '--dry-run', '--discard-local']);
const POSITIONAL_COMMANDS = new Set(['archive-pull']);

const USAGE =
  'usage: art-store <manifest [--check] [--add paths] [--remove keys] [--take-local keys] | pull [--repair] [--discard-local] [--dry-run] | check-untracked | materialize | verify-store | publish [--repair] [--dry-run] | archive | archive-pull [prefix]> [--store dir] [--manifest file] [--public-root dir] [--hydrated-record file]';

function parseArgs(argv: readonly string[]): CliOptions {
  const [command = '', ...rest] = argv;
  const options: CliOptions = { command, flags: new Set(), values: new Map(), lists: new Map(), positionals: [] };
  let list: string[] | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = rest[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options.values.set(arg, path.resolve(value));
      i += 1;
      list = null;
    } else if (LIST_FLAGS.has(arg)) {
      list = options.lists.get(arg) ?? [];
      options.lists.set(arg, list);
    } else if (BOOLEAN_FLAGS.has(arg)) {
      options.flags.add(arg);
      list = null;
    } else if (list && !arg.startsWith('--')) {
      list.push(arg);
    } else if (POSITIONAL_COMMANDS.has(command) && !arg.startsWith('--')) {
      options.positionals.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

type Context = {
  config: ResolvedConfig;
  runtime: ResolvedRuntime;
  options: CliOptions;
  publicRoot: string;
  manifestPath: string;
  recordPath: string;
  storeDir: string;
  keySpace: KeySpace;
};

function buildContext(command: string, config: ResolvedConfig, options: CliOptions): Context {
  const { runtime } = config;
  if (!runtime) throw new Error(`art-store ${command} needs the runtime store settings (publicRoot, manifest, hydratedRecord, trackedDir, extensions, store) in ${CONFIG_FILE_NAME}`);
  const publicRoot = options.values.get('--public-root') ?? runtime.publicRoot;
  return {
    config,
    runtime,
    options,
    publicRoot,
    manifestPath: options.values.get('--manifest') ?? runtime.manifestPath,
    recordPath: options.values.get('--hydrated-record') ?? runtime.recordPath,
    storeDir: options.values.get('--store') ?? resolveArtStoreDir(config.repoRoot, runtime.store),
    keySpace: { ...runtime.layout, publicRoot, publicRootRelative: runtime.publicRootRelative },
  };
}

function readManifest(context: Context): ArtManifest {
  return parseArtManifest(JSON.parse(fs.readFileSync(context.manifestPath, 'utf8')), context.runtime.layout);
}

function requirePublishTarget(config: ResolvedConfig): RemoteStoreTarget {
  if (!config.publish) throw new Error('art-store.config.json needs a "publish" section with host and projectDir');
  return config.publish;
}

function printLines(lines: readonly string[]): void {
  for (const line of lines) console.log(line);
}

function printProblems(lines: readonly string[]): void {
  for (const line of lines) console.error(line);
}

function describeCommand(binary: string, command: RsyncCommand): string {
  const files = command.stdin.split('\n').filter(Boolean).length;
  return `${[binary, ...command.args].join(' ')}   (stdin: ${files} file names)`;
}

function runRsync(command: RsyncCommand): string {
  return execFileSync('rsync', command.args, { input: command.stdin, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function runMaterialize(context: Context, manifest: ArtManifest): boolean {
  const result = materialize(manifest, context.publicRoot, context.storeDir, context.runtime.layout.extensions);
  console.log(`materialize: ${result.created} created, ${result.present} already present (${context.storeDir})`);
  const problems = [
    ...formatCapped('corrupt object', result.corrupt),
    ...formatCapped('missing source', result.missingSources),
    ...formatCapped('source changed since manifest', result.changedSources),
  ];
  printLines(formatCapped('repaired from local', result.repaired));
  printProblems(problems);
  return problems.length === 0;
}

function publish(context: Context, manifest: ArtManifest): boolean {
  const target = requirePublishTarget(context.config);
  const { storeDir } = context;
  const repair = context.options.flags.has('--repair');
  const names = [...objectNames(manifest, context.runtime.layout.extensions).keys()].sort();
  if (context.options.flags.has('--dry-run')) {
    console.log(`dry run: ${names.length} objects from ${storeDir}`);
    console.log(describeCommand('ssh', { args: buildMkdirCommand(target), stdin: '' }));
    console.log(describeCommand('rsync', buildSendCommand(storeDir, target, names)));
    console.log(describeCommand('rsync', buildVerifyCommand(storeDir, target, names)));
    if (repair) console.log(describeCommand('rsync', buildSendCommand(storeDir, target, ['<mismatched>'], true)));
    return true;
  }
  if (!runMaterialize(context, manifest)) return false;
  execFileSync('ssh', buildMkdirCommand(target), { stdio: 'inherit' });
  runRsync(buildSendCommand(storeDir, target, names));
  let mismatched = parseItemizedNames(runRsync(buildVerifyCommand(storeDir, target, names)));
  if (mismatched.length > 0 && repair) {
    runRsync(buildSendCommand(storeDir, target, mismatched, true));
    mismatched = parseItemizedNames(runRsync(buildVerifyCommand(storeDir, target, names)));
  }
  if (mismatched.length > 0) {
    printProblems(formatCapped('remote mismatch', mismatched));
    return false;
  }
  console.log(`publish: ${names.length} objects on ${target.host}:${remoteStoreDir(target)} match local bytes`);
  return true;
}

function runManifestCommand(context: Context): number {
  const { options, publicRoot, manifestPath, recordPath } = context;
  const manifest = readManifest(context);
  const local = hashLocalKeys(Object.keys(manifest.entries), publicRoot);
  if (options.flags.has('--check')) {
    const { missing, differs } = checkLocal(manifest, local);
    const problems = [
      ...formatCapped('missing locally (run art-store pull)', missing),
      ...formatCapped('differs from manifest', differs),
    ];
    if (problems.length > 0) {
      printProblems(problems);
      return 1;
    }
    console.log(`manifest OK: ${Object.keys(manifest.entries).length} entries match local files`);
    return 0;
  }

  const record = readHydratedRecord(recordPath);
  const takeLocal = (options.lists.get('--take-local') ?? []).map((arg) => normalizeArtKey(arg, context.keySpace));
  const edits = applyLocalEdits(manifest, local, record, takeLocal);
  const addKeys = resolveAddKeys(options.lists.get('--add') ?? [], context.keySpace);
  const addedHashes = new Map(
    addKeys.filter((key) => !(key in edits.manifest.entries)).map((key) => [key, hashFile(path.join(publicRoot, key))] as const),
  );
  const changes = applyAddRemove(edits.manifest, addedHashes, options.lists.get('--remove') ?? []);
  const nextRecord = edits.record;
  for (const key of changes.added) nextRecord[key] = changes.manifest.entries[key];
  for (const key of changes.removed) delete nextRecord[key];
  fs.writeFileSync(manifestPath, serializeManifest(changes.manifest));
  writeHydratedRecord(recordPath, nextRecord);
  console.log(
    `manifest: ${Object.keys(changes.manifest.entries).length} entries (${edits.updated.length} updated, ${changes.added.length} added, ${changes.removed.length} removed) -> ${manifestPath}`,
  );
  printLines([
    ...formatCapped('updated', edits.updated),
    ...formatCapped('added', changes.added),
    ...formatCapped('removed', changes.removed),
  ]);
  if (edits.conflicts.length === 0) return 0;
  printProblems([
    ...formatCapped('conflict', edits.conflicts),
    'resolve: art-store manifest --take-local <keys> (accept local bytes) or art-store pull --discard-local (accept the manifest)',
  ]);
  return 1;
}

function runPull(context: Context): number {
  const { options } = context;
  const dryRun = options.flags.has('--dry-run');
  const result = pull(readManifest(context), {
    publicRoot: context.publicRoot,
    storeDir: context.storeDir,
    target: requirePublishTarget(context.config),
    extensions: context.runtime.layout.extensions,
    record: readHydratedRecord(context.recordPath),
    runner: (command) => {
      runRsync(command);
    },
    repair: options.flags.has('--repair'),
    discardLocal: options.flags.has('--discard-local'),
    dryRun,
    linkHydrated: isLaneSnapshot(context.config.repoRoot),
  });
  if (!dryRun) writeHydratedRecord(context.recordPath, result.record);
  for (const line of reportPull(result, dryRun)) (line.startsWith('error:') ? console.error : console.log)(line);
  return result.exitCode;
}

function runCheckUntracked(context: Context): number {
  const { config, runtime } = context;
  const out = execFileSync('git', ['ls-files', '-z', '--', `${runtime.publicRootRelative}/${runtime.layout.trackedDir}`], {
    cwd: config.repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const tracked = findTrackedImages(out.split('\0').filter(Boolean), runtime.layout.extensions);
  if (tracked.length === 0) {
    console.log('check-untracked OK: no art images are tracked');
    return 0;
  }
  printProblems(formatCapped('tracked image', tracked));
  console.error('fix: git rm --cached <paths> && art-store manifest --add <paths> && art-store publish');
  return 1;
}

function runVerifyStore(context: Context): number {
  const result = verifyStore(readManifest(context), context.storeDir, context.runtime.layout.extensions);
  const problems = [...formatCapped('missing object', result.missing), ...formatCapped('corrupt object', result.corrupt)];
  if (problems.length > 0) {
    printProblems(problems);
    return 1;
  }
  console.log(`verify-store OK: ${result.checked} objects in ${context.storeDir}`);
  return 0;
}

function withArchiveRemote<T>(config: ResolvedConfig, action: (settings: ArchiveSettings, remote: ArchiveRemote) => T): T {
  if (!config.archive) throw new Error('art-store.config.json needs an "archive" section');
  const remote = createSshArchiveRemote(config.archive.remote);
  try {
    return action(config.archive.settings, remote);
  } finally {
    remote.close();
  }
}

function runArchive(config: ResolvedConfig): number {
  withArchiveRemote(config, (settings, remote) => archive(settings, remote, { log: console.log }));
  return 0;
}

function runArchivePull(config: ResolvedConfig, options: CliOptions): number {
  const prefix = options.positionals[0] ?? '';
  const result = withArchiveRemote(config, (settings, remote) => archivePull(settings, remote, prefix));
  if (result.failed.length > 0) {
    printProblems(result.failed.map((failedPath) => `${failedPath}: FAILED`));
    console.error(`archive-pull: ${result.failed.length} of ${result.selected} files do not match the manifest`);
    return 1;
  }
  console.log(`archive-pull: ${result.selected} files verified (${result.fetched} fetched)`);
  return 0;
}

export function main(argv: readonly string[], cwd: string = process.cwd()): number {
  const options = parseArgs(argv);
  const runtimeCommand = (run: (context: Context) => number) => (config: ResolvedConfig) =>
    run(buildContext(options.command, config, options));
  const commands: Record<string, (config: ResolvedConfig) => number> = {
    manifest: runtimeCommand(runManifestCommand),
    pull: runtimeCommand(runPull),
    'check-untracked': runtimeCommand(runCheckUntracked),
    materialize: runtimeCommand((context) => (runMaterialize(context, readManifest(context)) ? 0 : 1)),
    'verify-store': runtimeCommand(runVerifyStore),
    publish: runtimeCommand((context) => (publish(context, readManifest(context)) ? 0 : 1)),
    archive: runArchive,
    'archive-pull': (config) => runArchivePull(config, options),
  };
  const run = commands[options.command];
  if (!run) {
    console.error(USAGE);
    return 1;
  }
  return run(loadConfig(cwd));
}
