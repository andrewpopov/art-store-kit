import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  artObjectName,
  hashBytes,
  isArtObjectName,
  isLaneSnapshot,
  main,
  parseArtManifest,
  resolveArtStoreDir,
  resolveConfig,
  findConfigFile,
} from '../index';
import { parseArtManifest as browserParse } from '../manifest';

const layout = { trackedDir: 'art', extensions: ['webp', 'png'] };
const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'art-config-'));
const validConfig = {
  publicRoot: 'apps/web/public',
  manifest: 'data/manifest.json',
  hydratedRecord: '.art-hydrated.json',
  trackedDir: 'art',
  extensions: ['webp', 'png'],
  store: { dir: '.art-store', machineCache: 'app/art-store' },
};

afterEach(() => vi.restoreAllMocks());

test('manifest parsing enforces the tracked directory, extension, traversal and hash shape', () => {
  const good = { version: 1, hash: 'sha256-128', entries: { 'art/a.webp': hashBytes(Buffer.from('a')) } };
  assert.deepEqual(parseArtManifest(good, layout), good);
  assert.equal(browserParse, parseArtManifest);
  const bad = (key: string, hash = hashBytes(Buffer.from('a'))) => ({ ...good, entries: { [key]: hash } });
  assert.throws(() => parseArtManifest(bad('other/a.webp'), layout), /must start with "art\/"/);
  assert.throws(() => parseArtManifest(bad('art/../a.webp'), layout), /must not contain "\.\."/);
  assert.throws(() => parseArtManifest(bad('art/a.txt'), layout), /disallowed extension/);
  assert.throws(() => parseArtManifest(bad('art/a.webp', 'ABC'), layout), /lowercase hex/);
  assert.throws(() => parseArtManifest({ ...good, version: 2 }, layout), /version must be 1/);
});

test('object names are <hash>.<lowercase ext> and recognised by isArtObjectName', () => {
  const hash = hashBytes(Buffer.from('a'));
  assert.equal(artObjectName('art/Sub/A.WEBP', hash, layout.extensions), `${hash}.webp`);
  assert.throws(() => artObjectName('art/a.txt', hash, layout.extensions), /no allowed extension/);
  assert.ok(isArtObjectName(`${hash}.png`, layout.extensions));
  assert.ok(!isArtObjectName(`${hash}.gif`, layout.extensions));
});

test('src/manifest.ts imports no node: module so web bundles can use it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'manifest.ts'), 'utf8');
  assert.doesNotMatch(source, /from ['"](node:|fs|path|crypto|os)/);
});

test('store dir: ART_STORE_DIR wins, a lane snapshot uses the machine cache, a checkout uses its own dir', () => {
  const location = { dirName: '.art-store', machineCache: 'app/art-store' };
  const checkout = tempDir();
  fs.mkdirSync(path.join(checkout, '.git'));
  const home = () => '/home/u';
  assert.equal(resolveArtStoreDir(checkout, location, { ART_STORE_DIR: '/x/y' }, home), '/x/y');
  assert.equal(resolveArtStoreDir(checkout, location, {}, home), path.join(checkout, '.art-store'));
  assert.equal(resolveArtStoreDir(checkout, location, { LANE_BROKER_EXECUTOR: 'remote' }, home), '/home/u/.cache/app/art-store');
  assert.equal(
    resolveArtStoreDir(checkout, location, { LANE_BROKER_EXECUTOR: 'remote', XDG_CACHE_HOME: '/xdg' }, home),
    '/xdg/app/art-store',
  );
  assert.equal(isLaneSnapshot(tempDir(), {}), true);
  assert.equal(isLaneSnapshot(checkout, {}), false);
});

test('store dir: a worktree resolves to the owner checkout store', () => {
  const owner = tempDir();
  const worktree = tempDir();
  fs.mkdirSync(path.join(owner, '.git', 'worktrees', 'w1'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(owner, '.git', 'worktrees', 'w1')}\n`);
  const location = { dirName: '.art-store', machineCache: 'c' };
  assert.equal(resolveArtStoreDir(worktree, location, {}), path.join(owner, '.art-store'));
});

test('config resolution names the missing or invalid field and has no defaults', () => {
  const repo = tempDir();
  const resolved = resolveConfig(validConfig, repo);
  assert.equal(resolved.publicRoot, path.join(repo, 'apps/web/public'));
  assert.equal(resolved.publish, null);
  assert.equal(resolved.archive, null);
  for (const key of Object.keys(validConfig)) {
    const { [key]: _omitted, ...rest } = validConfig as Record<string, unknown>;
    assert.throws(() => resolveConfig(rest, repo), new RegExp(key === 'store' ? 'store' : key));
  }
  assert.throws(() => resolveConfig({ ...validConfig, extensions: ['.png'] }, repo), /extensions must be a non-empty array/);
  assert.throws(() => resolveConfig({ ...validConfig, manifest: '../x.json' }, repo), /manifest must be a relative path/);
  assert.throws(() => resolveConfig({ ...validConfig, publish: { host: 'h' } }, repo), /publish\.projectDir/);
  assert.throws(() => resolveConfig({ ...validConfig, archive: { remote: 'h' } }, repo), /archive\.root/);
});

test('publish target and archive settings resolve against the repo root', () => {
  const repo = tempDir();
  const resolved = resolveConfig(
    {
      ...validConfig,
      publish: { host: 'h', projectDir: '/srv/app' },
      archive: { remote: 'r', root: '/data/a', sourceDir: 'src', extensions: ['png'], manifest: 'src/m.sha256', requireMount: '/data', snapshotPrefix: 'masters' },
    },
    repo,
  );
  assert.deepEqual(resolved.publish, { host: 'h', projectDir: '/srv/app', storeName: '.art-store' });
  assert.equal(resolved.archive?.settings.sourceDir, path.join(repo, 'src'));
  assert.equal(resolved.archive?.settings.manifestPath, path.join(repo, 'src/m.sha256'));
});

test('the config file is found from a nested cwd', () => {
  const repo = tempDir();
  fs.writeFileSync(path.join(repo, 'art-store.config.json'), JSON.stringify(validConfig));
  const nested = path.join(repo, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findConfigFile(nested), path.join(repo, 'art-store.config.json'));
});

test('cli: manifest --add, --check and verify-store round trip through the config, with art-store hints in errors', () => {
  const repo = tempDir();
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'data'));
  fs.writeFileSync(path.join(repo, 'art-store.config.json'), JSON.stringify(validConfig));
  fs.mkdirSync(path.join(repo, 'apps/web/public/art'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'apps/web/public/art/a.webp'), 'a');
  fs.writeFileSync(path.join(repo, 'apps/web/public/art/notes.txt'), 'n');
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fs.writeFileSync(path.join(repo, 'data/manifest.json'), '{"version":1,"hash":"sha256-128","entries":{}}');

  assert.equal(main(['manifest', '--add', 'apps/web/public/art'], repo), 0);
  const written = fs.readFileSync(path.join(repo, 'data/manifest.json'), 'utf8');
  assert.equal(
    written,
    `{\n  "version": 1,\n  "hash": "sha256-128",\n  "entries": {\n    "art/a.webp": "${hashBytes(Buffer.from('a'))}"\n  }\n}\n`,
  );
  assert.equal(main(['manifest', '--check'], repo), 0);
  assert.equal(main(['materialize'], repo), 0);
  assert.equal(main(['verify-store'], repo), 0);

  fs.writeFileSync(path.join(repo, `.art-store/${hashBytes(Buffer.from('a'))}.webp`), 'rot');
  assert.equal(main(['verify-store'], repo), 1);
  assert.match(err.mock.calls.flat().join('\n'), new RegExp(`corrupt object: ${hashBytes(Buffer.from('a'))}\\.webp`));

  fs.rmSync(path.join(repo, 'apps/web/public/art/a.webp'));
  err.mockClear();
  assert.equal(main(['manifest', '--check'], repo), 1);
  assert.match(err.mock.calls.flat().join('\n'), /missing locally \(run art-store pull\): art\/a\.webp/);
  assert.doesNotMatch(err.mock.calls.flat().join('\n'), /pnpm/);
  assert.ok(out.mock.calls.length > 0);
});

test('cli: publish without a publish section and an unknown command fail clearly', () => {
  const repo = tempDir();
  fs.mkdirSync(path.join(repo, 'data'));
  fs.writeFileSync(path.join(repo, 'art-store.config.json'), JSON.stringify(validConfig));
  fs.writeFileSync(path.join(repo, 'data/manifest.json'), '{"version":1,"hash":"sha256-128","entries":{}}');
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  assert.throws(() => main(['publish'], repo), /needs a "publish" section/);
  assert.equal(main(['bogus'], repo), 1);
  assert.match(err.mock.calls.flat().join('\n'), /usage: art-store/);
  assert.throws(() => main(['verify-store', '--nope'], repo), /Unknown argument: --nope/);
});
