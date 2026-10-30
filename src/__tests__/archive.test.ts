import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  archive,
  archivePull,
  createSshArchiveRemote,
  parseArchiveManifest,
  snapshotStamp,
  type ArchiveRemote,
  type ArchiveSettings,
  type Exec,
} from '../index';

const sha = (content: string): string => createHash('sha256').update(content).digest('hex');
const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'art-archive-'));
const fixedClock = () => new Date('2026-03-04T05:06:07.890Z');

type Fixture = { settings: ArchiveSettings; remote: ArchiveRemote; calls: string[]; remoteRoot: string; sourceDir: string };

function fakeRemote(mounts: string[], calls: string[]): ArchiveRemote {
  return {
    label: 'fake-host',
    isMountpoint: (mount) => mounts.includes(mount),
    ensureDirs: (dirs) => dirs.forEach((dir) => fs.mkdirSync(dir, { recursive: true })),
    upload(localFile, remoteFile) {
      calls.push(`upload ${path.basename(remoteFile)}`);
      if (!fs.existsSync(remoteFile)) fs.copyFileSync(localFile, remoteFile);
    },
    verifyObjects(objectsDir, checksumLines) {
      const failed = checksumLines
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('  '))
        .filter(([expected, name]) => {
          const file = path.join(objectsDir, name);
          return !fs.existsSync(file) || sha(fs.readFileSync(file, 'utf8')) !== expected;
        })
        .map(([, name]) => `${name}: FAILED`);
      return { ok: failed.length === 0, output: failed.join('\n') };
    },
    writeNoClobber: (remoteFile, content) => fs.writeFileSync(remoteFile, content, { flag: 'wx' }),
    download(remoteFile, localFile) {
      calls.push(`download ${path.basename(remoteFile)}`);
      fs.copyFileSync(remoteFile, localFile);
    },
  };
}

function fixture(files: Record<string, string>, mounts = ['/mnt/archive']): Fixture {
  const base = tempDir();
  const sourceDir = path.join(base, 'design-src');
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(sourceDir, relative)), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, relative), content);
  }
  const remoteRoot = path.join(base, 'remote', 'design-src');
  const calls: string[] = [];
  const settings: ArchiveSettings = {
    root: remoteRoot,
    requireMount: '/mnt/archive',
    snapshotPrefix: 'masters',
    sourceDir,
    manifestPath: path.join(sourceDir, 'masters.sha256'),
    extensions: ['png'],
  };
  return { settings, remote: fakeRemote(mounts, calls), calls, remoteRoot, sourceDir };
}

const stableFiles = { 'b/two.png': 'two', 'a.png': 'one', 'notes.txt': 'skip me' };

test('archive writes the objects/ and manifests/ layout and a sha256sum-format manifest', () => {
  const { settings, remote, remoteRoot } = fixture(stableFiles);
  const result = archive(settings, remote, { now: fixedClock });
  const expectedManifest = `${sha('one')}  a.png\n${sha('two')}  b/two.png\n`;
  assert.equal(result.count, 2);
  assert.equal(fs.readFileSync(settings.manifestPath, 'utf8'), expectedManifest);
  assert.deepEqual(fs.readdirSync(path.join(remoteRoot, 'objects')).sort(), [`${sha('one')}.png`, `${sha('two')}.png`].sort());
  assert.equal(result.snapshot, 'masters-20260304T050607Z.sha256');
  assert.equal(fs.readFileSync(path.join(remoteRoot, 'manifests', result.snapshot), 'utf8'), expectedManifest);
});

test('archive sorts manifest paths bytewise like LC_ALL=C sort', () => {
  const { settings, remote } = fixture({ 'B.png': '1', 'a.png': '2', 'a/z.png': '3', 'a-b.png': '4' });
  archive(settings, remote, { now: fixedClock });
  const paths = parseArchiveManifest(fs.readFileSync(settings.manifestPath, 'utf8')).map((entry) => entry.path);
  assert.deepEqual(paths, ['B.png', 'a-b.png', 'a.png', 'a/z.png']);
});

test('archive refuses when the remote mount is not a mountpoint and touches nothing', () => {
  const { settings, remote, remoteRoot, calls } = fixture(stableFiles, []);
  assert.throws(() => archive(settings, remote, { now: fixedClock }), /fake-host:\/mnt\/archive is not a mounted filesystem; refusing/);
  assert.deepEqual(calls, []);
  assert.ok(!fs.existsSync(remoteRoot));
  assert.ok(!fs.existsSync(settings.manifestPath));
});

test('archive refuses when no matching files exist', () => {
  const { settings, remote } = fixture({ 'notes.txt': 'x' });
  assert.throws(() => archive(settings, remote), /no \*\.png files found/);
});

test('archive uploads ignore-existing and the remote re-hash names a corrupted object, leaving the committed manifest alone', () => {
  const { settings, remote, remoteRoot } = fixture(stableFiles);
  const objectsDir = path.join(remoteRoot, 'objects');
  fs.mkdirSync(objectsDir, { recursive: true });
  fs.writeFileSync(path.join(objectsDir, `${sha('one')}.png`), 'corrupted on the remote');
  fs.writeFileSync(settings.manifestPath, 'previous committed manifest\n');
  assert.throws(() => archive(settings, remote, { now: fixedClock }), new RegExp(`verification on fake-host failed[^]*${sha('one')}\\.png: FAILED`));
  assert.equal(fs.readFileSync(path.join(objectsDir, `${sha('one')}.png`), 'utf8'), 'corrupted on the remote');
  assert.equal(fs.readFileSync(settings.manifestPath, 'utf8'), 'previous committed manifest\n');
  assert.ok(!fs.existsSync(path.join(remoteRoot, 'manifests')) || fs.readdirSync(path.join(remoteRoot, 'manifests')).length === 0);
});

test('archive never clobbers an existing snapshot manifest', () => {
  const { settings, remote } = fixture(stableFiles);
  archive(settings, remote, { now: fixedClock });
  assert.throws(() => archive(settings, remote, { now: fixedClock }), /EEXIST/);
});

test('archive-pull fetches only missing or mismatched files and honours the prefix', () => {
  const { settings, remote, calls, sourceDir } = fixture({ 'a/one.png': 'one', 'a/two.png': 'two', 'b/three.png': 'three' });
  archive(settings, remote, { now: fixedClock });
  fs.rmSync(path.join(sourceDir, 'a/one.png'));
  fs.writeFileSync(path.join(sourceDir, 'a/two.png'), 'edited');
  fs.rmSync(path.join(sourceDir, 'b'), { recursive: true });
  calls.length = 0;
  const result = archivePull(settings, remote, 'a/');
  assert.deepEqual(result, { selected: 2, fetched: 2, failed: [] });
  assert.deepEqual(calls.sort(), [`download ${sha('one')}.png`, `download ${sha('two')}.png`].sort());
  assert.equal(fs.readFileSync(path.join(sourceDir, 'a/two.png'), 'utf8'), 'two');
  assert.ok(!fs.existsSync(path.join(sourceDir, 'b/three.png')));
  calls.length = 0;
  assert.deepEqual(archivePull(settings, remote, 'a/').fetched, 0);
  assert.deepEqual(calls, []);
});

test('archive-pull names a path whose remote object is corrupt', () => {
  const { settings, remote, remoteRoot, sourceDir } = fixture(stableFiles);
  archive(settings, remote, { now: fixedClock });
  fs.writeFileSync(path.join(remoteRoot, 'objects', `${sha('two')}.png`), 'bit rot');
  fs.rmSync(path.join(sourceDir, 'b'), { recursive: true });
  assert.deepEqual(archivePull(settings, remote).failed, ['b/two.png']);
});

test('archive-pull rejects a missing manifest and a prefix that matches nothing', () => {
  const { settings, remote } = fixture(stableFiles);
  assert.throws(() => archivePull(settings, remote), /missing .*masters\.sha256/);
  archive(settings, remote, { now: fixedClock });
  assert.throws(() => archivePull(settings, remote, 'nope/'), /no manifest entries match prefix 'nope\/'/);
});

test('parseArchiveManifest rejects malformed lines and paths that escape the source dir', () => {
  assert.throws(() => parseArchiveManifest('not a manifest line\n'), /malformed archive manifest line/);
  assert.throws(() => parseArchiveManifest(`${sha('x')}  ../escape.png\n`), /unsafe archive manifest path/);
  assert.throws(() => parseArchiveManifest(`${sha('x')}  /abs.png\n`), /unsafe archive manifest path/);
});

test('snapshotStamp is UTC with no separators, matching date -u +%Y%m%dT%H%M%SZ', () => {
  assert.equal(snapshotStamp(new Date('2026-12-31T23:59:58.999Z')), '20261231T235958Z');
});

function recordingExec(fail: (file: string, args: readonly string[]) => Error | null = () => null) {
  const calls: { file: string; args: readonly string[]; input?: string }[] = [];
  const exec: Exec = (file, args, input) => {
    calls.push({ file, args, input });
    const error = fail(file, args);
    if (error) throw error;
    return '';
  };
  return { calls, exec };
}

test('ssh remote builds the guarded commands: mountpoint, mkdir, ignore-existing upload, sha256sum -c, no-clobber write', () => {
  const { calls, exec } = recordingExec();
  const remote = createSshArchiveRemote('fake-host', { exec, controlDir: tempDir() });
  assert.equal(remote.isMountpoint('/mnt/it\'s'), true);
  remote.ensureDirs(['/r/objects', '/r/manifests']);
  remote.upload('/local/a.png', 'fake-host-path');
  remote.verifyObjects('/r/objects', 'sum  name\n');
  remote.writeNoClobber('/r/manifests/m.sha256', 'body');
  const scripts = calls.filter((call) => call.file === 'ssh').map((call) => call.args.at(-1));
  assert.deepEqual(scripts, [
    `mountpoint -q '/mnt/it'\\''s'`,
    `mkdir -p '/r/objects' '/r/manifests'`,
    `cd '/r/objects' && sha256sum -c --quiet`,
    `set -C; cat > '/r/manifests/m.sha256'`,
  ]);
  assert.equal(calls.find((call) => call.args.at(-1)?.startsWith('cd '))?.input, 'sum  name\n');
  const upload = calls.find((call) => call.file === 'rsync');
  assert.ok(upload?.args.includes('--ignore-existing'));
  assert.equal(upload?.args.at(-1), 'fake-host:fake-host-path');
});

test('ssh remote reports not-a-mountpoint and failed verification without throwing', () => {
  const failure = Object.assign(new Error('exit 1'), { stdout: 'x.png: FAILED\n' });
  const { exec } = recordingExec(() => failure);
  const remote = createSshArchiveRemote('fake-host', { exec, controlDir: tempDir() });
  assert.equal(remote.isMountpoint('/mnt/archive'), false);
  assert.deepEqual(remote.verifyObjects('/r/objects', 'sum  x.png\n'), { ok: false, output: 'x.png: FAILED\n' });
});
