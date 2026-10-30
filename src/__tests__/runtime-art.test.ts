import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  applyAddRemove,
  applyLocalEdits,
  artObjectName,
  buildManifest,
  buildMkdirCommand,
  buildSendCommand,
  buildVerifyCommand,
  checkLocal,
  findTrackedImages,
  hashBytes,
  hashFile,
  hashLocalKeys,
  materialize,
  parseItemizedNames,
  pull,
  reportPull,
  resolveAddKeys,
  serializeManifest,
  verifyStore,
  type ArtManifest,
  type PullOptions,
  type RsyncCommand,
  type RsyncRunner,
} from '../index';

const extensions = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'svg'];
const layout = { trackedDir: 'art', extensions };
const keySpace = (publicRoot: string) => ({ ...layout, publicRoot, publicRootRelative: 'apps/web/public' });
const runtimeArtObjectName = (key: string, hash: string): string => artObjectName(key, hash, extensions);

const target = { host: 'user@example-host', projectDir: '/srv/app', storeName: '.art-store' };

function makePublicRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'art-store-public-'));
  for (const [key, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, key)), { recursive: true });
    fs.writeFileSync(path.join(root, key), content);
  }
  return root;
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'art-store-store-'));
}

function manifestFor(root: string, keys: string[]) {
  return buildManifest(keys, (key) => fs.readFileSync(path.join(root, key)), extensions);
}

test('manifest is sorted, skips non-image files, and serializes to stable bytes', () => {
  const root = makePublicRoot({ 'art/b.webp': 'b', 'art/a.png': 'a', 'art/notes.txt': 'n' });
  const keys = ['art/b.webp', 'art/notes.txt', 'art/a.png'];
  const first = serializeManifest(manifestFor(root, keys));
  const second = serializeManifest(manifestFor(root, [...keys].reverse()));
  assert.equal(first, second);
  assert.deepEqual(Object.keys(JSON.parse(first).entries), ['art/a.png', 'art/b.webp']);
  assert.equal(
    first,
    `{\n  "version": 1,\n  "hash": "sha256-128",\n  "entries": {\n    "art/a.png": "${hashBytes(Buffer.from('a'))}",\n    "art/b.webp": "${hashBytes(Buffer.from('b'))}"\n  }\n}\n`,
  );
});

test('materialize creates objects and is idempotent', () => {
  const root = makePublicRoot({ 'art/a.webp': 'one', 'art/b.png': 'two' });
  const manifest = manifestFor(root, ['art/a.webp', 'art/b.png']);
  const store = makeTempDir();
  const first = materialize(manifest, root, store, extensions);
  assert.deepEqual([first.created, first.present], [2, 0]);
  const name = runtimeArtObjectName('art/a.webp', manifest.entries['art/a.webp']);
  assert.equal(fs.readFileSync(path.join(store, name), 'utf8'), 'one');
  const second = materialize(manifest, root, store, extensions);
  assert.deepEqual([second.created, second.present], [0, 2]);
  assert.deepEqual(fs.readdirSync(store).sort(), [
    runtimeArtObjectName('art/a.webp', manifest.entries['art/a.webp']),
    runtimeArtObjectName('art/b.png', manifest.entries['art/b.png']),
  ].sort());
});

test('materialize repairs a corrupt existing object from the validated source', () => {
  const root = makePublicRoot({ 'art/a.webp': 'one' });
  const manifest = manifestFor(root, ['art/a.webp']);
  const store = makeTempDir();
  const name = runtimeArtObjectName('art/a.webp', manifest.entries['art/a.webp']);
  fs.writeFileSync(path.join(store, name), 'tampered');
  const result = materialize(manifest, root, store, extensions);
  assert.deepEqual(result.repaired, [name]);
  assert.deepEqual(result.corrupt, []);
  assert.equal(fs.readFileSync(path.join(store, name), 'utf8'), 'one');
});

test('materialize reports a corrupt existing object whose source is missing', () => {
  const root = makePublicRoot({ 'art/a.webp': 'one' });
  const manifest = manifestFor(root, ['art/a.webp']);
  fs.rmSync(path.join(root, 'art/a.webp'));
  const store = makeTempDir();
  const name = runtimeArtObjectName('art/a.webp', manifest.entries['art/a.webp']);
  fs.writeFileSync(path.join(store, name), 'tampered');
  assert.deepEqual(materialize(manifest, root, store, extensions).corrupt, [name]);
  assert.equal(fs.readFileSync(path.join(store, name), 'utf8'), 'tampered');
});

test('materialize reports a missing source and a source changed since the manifest', () => {
  const root = makePublicRoot({ 'art/a.webp': 'one', 'art/b.webp': 'two' });
  const manifest = manifestFor(root, ['art/a.webp', 'art/b.webp']);
  fs.rmSync(path.join(root, 'art/a.webp'));
  fs.writeFileSync(path.join(root, 'art/b.webp'), 'edited');
  const store = makeTempDir();
  const result = materialize(manifest, root, store, extensions);
  assert.deepEqual(result.missingSources, ['art/a.webp']);
  assert.deepEqual(result.changedSources, ['art/b.webp']);
  assert.deepEqual(fs.readdirSync(store), []);
});

test('verify-store names a missing object and a corrupt object', () => {
  const root = makePublicRoot({ 'art/a.webp': 'one', 'art/b.webp': 'two', 'art/c.webp': 'three' });
  const manifest = manifestFor(root, ['art/a.webp', 'art/b.webp', 'art/c.webp']);
  const store = makeTempDir();
  materialize(manifest, root, store, extensions);
  const missing = runtimeArtObjectName('art/a.webp', manifest.entries['art/a.webp']);
  const corrupt = runtimeArtObjectName('art/b.webp', manifest.entries['art/b.webp']);
  fs.rmSync(path.join(store, missing));
  fs.writeFileSync(path.join(store, corrupt), 'bad');
  const result = verifyStore(manifest, store, extensions);
  assert.deepEqual(result.missing, [missing]);
  assert.deepEqual(result.corrupt, [corrupt]);
  assert.equal(result.checked, 3);
});

test('publish send command is ignore-existing with a files-from list and host:path target', () => {
  const command = buildSendCommand('/store', target, ['a.webp', 'b.png']);
  assert.ok(command.args.includes('--ignore-existing'));
  assert.ok(command.args.includes('--files-from=-'));
  assert.ok(!command.args.includes('--checksum'));
  assert.equal(command.args.at(-1), 'user@example-host:/srv/app/.art-store/');
  assert.equal(command.stdin, 'a.webp\nb.png\n');
  assert.deepEqual(buildMkdirCommand(target), ['user@example-host', 'mkdir', '-p', '/srv/app/.art-store']);
});

test('publish repair command uses checksum and drops ignore-existing', () => {
  const command = buildSendCommand('/store', target, ['a.webp'], true);
  assert.ok(command.args.includes('--checksum'));
  assert.ok(!command.args.includes('--ignore-existing'));
});

test('publish verify command is a checksum dry run and itemized lines parse to names', () => {
  const command = buildVerifyCommand('/store', target, ['a.webp']);
  assert.ok(command.args.includes('-rn') && !command.args.includes('-rtn'));
  assert.ok(command.args.includes('--checksum'));
  assert.ok(command.args.includes('--itemize-changes'));
  assert.deepEqual(parseItemizedNames('>fc.t...... a.webp\n\n>f+++++++++ b.png\n'), ['a.webp', 'b.png']);
});

function entryHash(content: string): string {
  return hashBytes(Buffer.from(content));
}

function manifestOf(contents: Record<string, string>): ArtManifest {
  return { version: 1, hash: 'sha256-128', entries: Object.fromEntries(Object.entries(contents).map(([k, v]) => [k, entryHash(v)])) };
}

function storeWith(contents: string[]): string {
  const store = makeTempDir();
  for (const content of contents) fs.writeFileSync(path.join(store, `${entryHash(content)}.webp`), content);
  return store;
}

function fakeRemote(contents: string[], calls: RsyncCommand[]): RsyncRunner {
  return (command) => {
    calls.push(command);
    const store = command.args.at(-1)!.replace(/\/$/, '');
    for (const name of command.stdin.split('\n').filter(Boolean)) {
      const content = contents.find((c) => `${entryHash(c)}.webp` === name);
      if (content !== undefined) fs.writeFileSync(path.join(store, name), content);
    }
  };
}

function pullOptions(root: string, store: string, runner: RsyncRunner, extra: Partial<PullOptions> = {}): PullOptions {
  return { publicRoot: root, storeDir: store, target, extensions, record: {}, runner, ...extra };
}

test('manifest update rewrites true local edits but not an untouched-stale file', () => {
  const root = makePublicRoot({ 'art/edited.webp': 'edited', 'art/stale.webp': 'old', 'art/same.webp': 'same' });
  const manifest = manifestOf({ 'art/edited.webp': 'orig', 'art/stale.webp': 'new', 'art/same.webp': 'same', 'art/gone.webp': 'gone' });
  const record = { 'art/stale.webp': entryHash('old'), 'art/edited.webp': entryHash('orig') };
  const local = hashLocalKeys(Object.keys(manifest.entries), root);
  const result = applyLocalEdits(manifest, local, record);
  assert.deepEqual(result.updated, ['art/edited.webp']);
  assert.equal(result.manifest.entries['art/edited.webp'], entryHash('edited'));
  assert.equal(result.manifest.entries['art/stale.webp'], entryHash('new'));
  assert.equal(result.manifest.entries['art/gone.webp'], entryHash('gone'));
});

test('manifest --add takes files from a directory and --remove drops a key', () => {
  const root = makePublicRoot({ 'art/dir/a.webp': 'a', 'art/dir/sub/b.png': 'b', 'art/dir/License.txt': 't', 'art/other.webp': 'o' });
  const keys = resolveAddKeys(['apps/web/public/art/dir', path.join(root, 'art/other.webp')], keySpace(root));
  assert.deepEqual(keys, ['art/dir/a.webp', 'art/dir/sub/b.png', 'art/other.webp']);
  assert.deepEqual(resolveAddKeys(['art/dir/a.webp'], keySpace(root)), ['art/dir/a.webp']);
  const added = new Map(keys.map((k) => [k, hashFile(path.join(root, k))] as const));
  const result = applyAddRemove(manifestOf({ 'art/old.webp': 'old' }), added, ['art/old.webp']);
  assert.deepEqual(Object.keys(result.manifest.entries), keys);
  assert.deepEqual(result.removed, ['art/old.webp']);
  assert.deepEqual(result.added, keys);
});

test('manifest --check reports missing-locally and differs separately', () => {
  const root = makePublicRoot({ 'art/ok.webp': 'ok', 'art/diff.webp': 'changed' });
  const manifest = manifestOf({ 'art/ok.webp': 'ok', 'art/diff.webp': 'diff', 'art/missing.webp': 'm' });
  const result = checkLocal(manifest, hashLocalKeys(Object.keys(manifest.entries), root));
  assert.deepEqual(result, { missing: ['art/missing.webp'], differs: ['art/diff.webp'] });
});

test('check-untracked flags tracked images and allows non-image files', () => {
  assert.deepEqual(findTrackedImages(['apps/web/public/art/a.webp', 'apps/web/public/art/License.txt', 'apps/web/public/art/l.json'], extensions), [
    'apps/web/public/art/a.webp',
  ]);
});

test('pull adopts matching files before fetching and never fetches an unpublished manifested edit', () => {
  const root = makePublicRoot({ 'art/unpublished.webp': 'unpub' });
  const manifest = manifestOf({ 'art/unpublished.webp': 'unpub' });
  const store = makeTempDir();
  const calls: RsyncCommand[] = [];
  const result = pull(manifest, pullOptions(root, store, fakeRemote([], calls)));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.adopted, ['art/unpublished.webp']);
  assert.equal(calls.length, 0);
  assert.ok(fs.existsSync(path.join(store, `${entryHash('unpub')}.webp`)));
  assert.equal(result.record['art/unpublished.webp'], entryHash('unpub'));
});

test('pull fetches only missing objects and hydrates absent files, updating the record', () => {
  const root = makePublicRoot({ 'art/have.webp': 'have' });
  const manifest = manifestOf({ 'art/have.webp': 'have', 'art/inStore.webp': 'in-store', 'art/remote/x.webp': 'remote' });
  const store = storeWith(['in-store']);
  const calls: RsyncCommand[] = [];
  const result = pull(manifest, pullOptions(root, store, fakeRemote(['remote'], calls)));
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stdin, `${entryHash('remote')}.webp\n`);
  assert.ok(calls[0].args.includes('--ignore-existing') && calls[0].args.includes('--files-from=-'));
  assert.equal(calls[0].args.at(-2), 'user@example-host:/srv/app/.art-store/');
  assert.deepEqual(result.hydrated.sort(), ['art/inStore.webp', 'art/remote/x.webp']);
  assert.equal(fs.readFileSync(path.join(root, 'art/remote/x.webp'), 'utf8'), 'remote');
  assert.equal(result.record['art/remote/x.webp'], entryHash('remote'));
});

test('pull makes no runner call when every object is local', () => {
  const root = makePublicRoot({});
  const manifest = manifestOf({ 'art/a.webp': 'a' });
  const calls: RsyncCommand[] = [];
  const result = pull(manifest, pullOptions(root, storeWith(['a']), fakeRemote([], calls)));
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'art/a.webp'), 'utf8'), 'a');
});

test('pull rejects and deletes a corrupt fetched object', () => {
  const root = makePublicRoot({});
  const manifest = manifestOf({ 'art/a.webp': 'a' });
  const store = makeTempDir();
  const runner: RsyncRunner = (command) => {
    for (const name of command.stdin.split('\n').filter(Boolean)) fs.writeFileSync(path.join(store, name), 'garbage');
  };
  const result = pull(manifest, pullOptions(root, store, runner));
  assert.equal(result.exitCode, 1);
  assert.match(result.problems.join('\n'), /corrupt fetched object deleted/);
  assert.equal(fs.readdirSync(store).length, 0);
  assert.ok(!fs.existsSync(path.join(root, 'art/a.webp')));
});

test('pull exits 1 when the fetch fails while objects are missing', () => {
  const root = makePublicRoot({});
  const runner: RsyncRunner = () => {
    throw new Error('host unreachable');
  };
  const result = pull(manifestOf({ 'art/a.webp': 'a' }), pullOptions(root, makeTempDir(), runner));
  assert.equal(result.exitCode, 1);
  assert.match(result.problems[0], /host unreachable/);
});

test('a corrupt existing store object blocks hydration and --repair re-fetches it with --checksum', () => {
  const root = makePublicRoot({});
  const manifest = manifestOf({ 'art/a.webp': 'a' });
  const store = makeTempDir();
  const objectPath = path.join(store, `${entryHash('a')}.webp`);
  fs.writeFileSync(objectPath, 'bad');
  const blockedCalls: RsyncCommand[] = [];
  const blocked = pull(manifest, pullOptions(root, store, fakeRemote(['a'], blockedCalls)));
  assert.equal(blocked.exitCode, 1);
  assert.equal(blockedCalls.length, 0);
  assert.ok(!fs.existsSync(path.join(root, 'art/a.webp')));
  const repairCalls: RsyncCommand[] = [];
  const repaired = pull(manifest, pullOptions(root, store, fakeRemote(['a'], repairCalls), { repair: true }));
  assert.equal(repaired.exitCode, 0);
  assert.ok(repairCalls[0].args.includes('--checksum'));
  assert.equal(fs.readFileSync(path.join(root, 'art/a.webp'), 'utf8'), 'a');
});

test('pull overwrites a stale-untouched file, keeps a local edit, and --discard-local overwrites it', () => {
  const manifest = manifestOf({ 'art/stale.webp': 'new-stale', 'art/edit.webp': 'new-edit' });
  const make = () => makePublicRoot({ 'art/stale.webp': 'old-stale', 'art/edit.webp': 'my-edit' });
  const record = { 'art/stale.webp': entryHash('old-stale'), 'art/edit.webp': entryHash('older') };
  const store = storeWith(['new-stale', 'new-edit']);
  const root = make();
  const kept = pull(manifest, pullOptions(root, store, fakeRemote([], []), { record }));
  assert.equal(kept.exitCode, 0);
  assert.deepEqual(kept.localEditsKept, ['art/edit.webp']);
  assert.match(reportPull(kept, false).join('\n'), /local edit kept: art\/edit\.webp/);
  assert.equal(fs.readFileSync(path.join(root, 'art/stale.webp'), 'utf8'), 'new-stale');
  assert.equal(fs.readFileSync(path.join(root, 'art/edit.webp'), 'utf8'), 'my-edit');
  assert.equal(kept.record['art/stale.webp'], entryHash('new-stale'));
  assert.equal(kept.record['art/edit.webp'], entryHash('older'));
  const discardRoot = make();
  const discarded = pull(manifest, pullOptions(discardRoot, store, fakeRemote([], []), { record, discardLocal: true }));
  assert.equal(fs.readFileSync(path.join(discardRoot, 'art/edit.webp'), 'utf8'), 'new-edit');
  assert.equal(discarded.record['art/edit.webp'], entryHash('new-edit'));
});

test('pull --dry-run writes nothing and counts adopted objects as available', () => {
  const root = makePublicRoot({ 'art/a.webp': 'a' });
  const manifest = manifestOf({ 'art/a.webp': 'a', 'art/b.webp': 'b' });
  const store = makeTempDir();
  const calls: RsyncCommand[] = [];
  const result = pull(manifest, pullOptions(root, store, fakeRemote(['b'], calls), { dryRun: true }));
  assert.deepEqual(result.adopted, ['art/a.webp']);
  assert.deepEqual(result.fetched, [`${entryHash('b')}.webp`]);
  assert.equal(calls.length, 0);
  assert.equal(fs.readdirSync(store).length, 0);
  assert.ok(!fs.existsSync(path.join(root, 'art/b.webp')));
});

test('manifest update applies the provenance rule per key and reports conflicts', () => {
  const root = makePublicRoot({
    'art/sync.webp': 'm',
    'art/edit.webp': 'edit',
    'art/stale.webp': 'r',
    'art/both.webp': 'both-local',
    'art/unknown.webp': 'local',
  });
  const manifest = manifestOf({
    'art/sync.webp': 'm',
    'art/edit.webp': 'orig',
    'art/stale.webp': 'upstream',
    'art/both.webp': 'upstream',
    'art/unknown.webp': 'upstream',
  });
  const record = {
    'art/edit.webp': entryHash('orig'),
    'art/stale.webp': entryHash('r'),
    'art/both.webp': entryHash('base'),
  };
  const result = applyLocalEdits(manifest, hashLocalKeys(Object.keys(manifest.entries), root), record);
  assert.deepEqual(result.updated, ['art/edit.webp']);
  assert.deepEqual(result.conflicts.sort(), ['art/both.webp', 'art/unknown.webp']);
  assert.equal(result.manifest.entries['art/edit.webp'], entryHash('edit'));
  assert.equal(result.record['art/edit.webp'], entryHash('edit'));
  assert.equal(result.manifest.entries['art/stale.webp'], entryHash('upstream'));
  assert.equal(result.manifest.entries['art/both.webp'], entryHash('upstream'));
  assert.equal(result.manifest.entries['art/unknown.webp'], entryHash('upstream'));
});

test('manifest --take-local accepts local bytes for the named keys only', () => {
  const root = makePublicRoot({ 'art/both.webp': 'both-local', 'art/unknown.webp': 'local' });
  const manifest = manifestOf({ 'art/both.webp': 'upstream', 'art/unknown.webp': 'upstream' });
  const record = { 'art/both.webp': entryHash('base') };
  const local = hashLocalKeys(Object.keys(manifest.entries), root);
  const result = applyLocalEdits(manifest, local, record, ['art/both.webp']);
  assert.deepEqual(result.updated, ['art/both.webp']);
  assert.deepEqual(result.conflicts, ['art/unknown.webp']);
  assert.equal(result.manifest.entries['art/both.webp'], entryHash('both-local'));
  assert.equal(result.record['art/both.webp'], entryHash('both-local'));
  assert.throws(() => applyLocalEdits(manifest, local, record, ['art/nope.webp']), /not in manifest/);
});

test('manifest --add leaves keys already in the manifest untouched', () => {
  const added = new Map([
    ['art/dir/old.webp', entryHash('rehashed')],
    ['art/dir/new.webp', entryHash('new')],
  ]);
  const result = applyAddRemove(manifestOf({ 'art/dir/old.webp': 'old' }), added, []);
  assert.deepEqual(result.added, ['art/dir/new.webp']);
  assert.equal(result.manifest.entries['art/dir/old.webp'], entryHash('old'));
});

test('pull keeps a file that appeared at an absent destination during the fetch', () => {
  const root = makePublicRoot({});
  const manifest = manifestOf({ 'art/a.webp': 'a' });
  const store = makeTempDir();
  const runner: RsyncRunner = (command) => {
    fakeRemote(['a'], [])(command);
    fs.mkdirSync(path.join(root, 'art'), { recursive: true });
    fs.writeFileSync(path.join(root, 'art/a.webp'), 'typed-during-pull');
  };
  const result = pull(manifest, pullOptions(root, store, runner));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.localEditsKept, ['art/a.webp']);
  assert.deepEqual(result.hydrated, []);
  assert.equal(fs.readFileSync(path.join(root, 'art/a.webp'), 'utf8'), 'typed-during-pull');
  assert.equal(result.record['art/a.webp'], undefined);
});

test('pull keeps a stale file edited during the fetch, and --discard-local still overwrites', () => {
  const manifest = manifestOf({ 'art/a.webp': 'new' });
  const record = { 'art/a.webp': entryHash('old') };
  const editingRunner = (root: string): RsyncRunner => (command) => {
    fakeRemote(['new'], [])(command);
    fs.writeFileSync(path.join(root, 'art/a.webp'), 'edited-during-pull');
  };
  const root = makePublicRoot({ 'art/a.webp': 'old' });
  const kept = pull(manifest, pullOptions(root, makeTempDir(), editingRunner(root), { record }));
  assert.deepEqual(kept.localEditsKept, ['art/a.webp']);
  assert.equal(fs.readFileSync(path.join(root, 'art/a.webp'), 'utf8'), 'edited-during-pull');
  assert.equal(kept.record['art/a.webp'], entryHash('old'));
  assert.match(reportPull(kept, false).join('\n'), /local edit kept: art\/a\.webp/);
  const discardRoot = makePublicRoot({ 'art/a.webp': 'old' });
  const discarded = pull(manifest, pullOptions(discardRoot, makeTempDir(), editingRunner(discardRoot), { record, discardLocal: true }));
  assert.equal(fs.readFileSync(path.join(discardRoot, 'art/a.webp'), 'utf8'), 'new');
  assert.equal(discarded.record['art/a.webp'], entryHash('new'));
});

test('pull adoption repairs a corrupt store object from the validated local file', () => {
  const root = makePublicRoot({ 'art/a.webp': 'a' });
  const manifest = manifestOf({ 'art/a.webp': 'a' });
  const store = makeTempDir();
  const name = `${entryHash('a')}.webp`;
  fs.writeFileSync(path.join(store, name), 'bad');
  const result = pull(manifest, pullOptions(root, store, fakeRemote([], [])));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.repaired, [name]);
  assert.equal(fs.readFileSync(path.join(store, name), 'utf8'), 'a');
  assert.match(reportPull(result, false).join('\n'), new RegExp(`repaired from local: ${name}`));
  assert.deepEqual(fs.readdirSync(store), [name]);
});

test('pull hydrates by hardlink from the store when linkHydrated, and by copy otherwise', () => {
  const manifest = manifestOf({ 'art/a.webp': 'a' });
  const hydrate = (extra: Partial<PullOptions>) => {
    const root = makePublicRoot({});
    const store = makeTempDir();
    const result = pull(manifest, pullOptions(root, store, fakeRemote(['a'], []), extra));
    assert.deepEqual(result.hydrated, ['art/a.webp']);
    const object = fs.statSync(path.join(store, `${entryHash('a')}.webp`));
    return { object, hydrated: fs.statSync(path.join(root, 'art/a.webp')) };
  };
  const linked = hydrate({ linkHydrated: true });
  assert.equal(linked.hydrated.ino, linked.object.ino);
  assert.equal(linked.object.nlink, 2);
  const copied = hydrate({});
  assert.notEqual(copied.hydrated.ino, copied.object.ino);
});

test('pull replaces a stale hydrated file with a link without touching the store object it was linked to', () => {
  const store = makeTempDir();
  const oldName = `${entryHash('old')}.webp`;
  fs.writeFileSync(path.join(store, oldName), 'old');
  const root = makePublicRoot({});
  fs.mkdirSync(path.join(root, 'art'), { recursive: true });
  fs.linkSync(path.join(store, oldName), path.join(root, 'art/a.webp'));
  const record = { 'art/a.webp': entryHash('old') };
  const result = pull(manifestOf({ 'art/a.webp': 'new' }), pullOptions(root, store, fakeRemote(['new'], []), { record, linkHydrated: true }));
  assert.deepEqual(result.hydrated, ['art/a.webp']);
  assert.equal(fs.readFileSync(path.join(root, 'art/a.webp'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(store, oldName), 'utf8'), 'old');
});

test('pull creates a missing nested store directory before the fetch (rsync makes only the last segment)', () => {
  const root = makePublicRoot({});
  const store = path.join(makeTempDir(), 'cache', 'art-store');
  const runner: RsyncRunner = (command) => {
    assert.ok(fs.existsSync(store), 'store dir must exist before rsync runs');
    fakeRemote(['a'], [])(command);
  };
  const result = pull(manifestOf({ 'art/a.webp': 'a' }), pullOptions(root, store, runner));
  assert.equal(result.exitCode, 0);
});
