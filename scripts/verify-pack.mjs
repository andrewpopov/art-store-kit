#!/usr/bin/env node
/**
 * Pack the package into a tarball, install it into a throwaway project, and
 * assert that:
 *   1. dist/index.d.ts ships inside the tarball.
 *   2. CommonJS `require()` exposes the named exports.
 *   3. Native ESM `import { ... }` resolves the same names (catches the
 *      "member-expression export" bug where cjs-module-lexer can't see the
 *      names for ESM consumers).
 *
 * art-store-kit has ZERO runtime dependencies, so the throwaway consumer installs
 * only the tarball. The `./manifest` subpath must stay free of `node:` imports
 * because web bundles import it.
 *
 * Exits non-zero with a clear message on any failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

const EXPECTED = ['materialize', 'pull', 'archive', 'archivePull', 'loadConfig', 'main'];
const EXPECTED_MANIFEST = ['parseArtManifest', 'artObjectName', 'isArtObjectName', 'isArtExtension'];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

function fail(message) {
  console.error(`\n[verify:pack] FAIL: ${message}\n`);
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'art-store-verify-'));
let tarballPath;

try {
  console.log('[verify:pack] Building...');
  run('npm', ['run', 'compile'], { cwd: pkgRoot, stdio: 'inherit' });

  if (!existsSync(join(pkgRoot, 'dist', 'index.d.ts'))) {
    fail('dist/index.d.ts is missing after build');
  }

  console.log('[verify:pack] Packing tarball...');
  const packOut = run('npm', ['pack', '--json', '--pack-destination', workDir], { cwd: pkgRoot });
  const filename = JSON.parse(packOut)[0].filename;
  tarballPath = join(workDir, filename);

  // 1. Assert the declaration file ships inside the tarball.
  const contents = run('tar', ['-tzf', tarballPath]);
  if (!contents.includes('package/dist/index.d.ts')) {
    fail('dist/index.d.ts is not present in the packed tarball');
  }
  console.log('[verify:pack] OK: dist/index.d.ts ships in tarball');

  // Throwaway consumer — zero peer deps.
  const consumerDir = join(workDir, 'consumer');
  run('mkdir', ['-p', consumerDir]);
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'art-store-consumer', version: '1.0.0', private: true }, null, 2),
  );

  console.log('[verify:pack] Installing tarball into consumer...');
  run('npm', ['install', '--no-audit', '--no-fund', tarballPath], { cwd: consumerDir, stdio: 'inherit' });

  const names = JSON.stringify(EXPECTED);

  // 2. CommonJS require smoke.
  const cjsSmoke = `
    const mod = require('${pkg.name}');
    const missing = ${names}.filter((n) => typeof mod[n] !== 'function');
    if (missing.length) { console.error('CJS missing exports: ' + missing.join(', ')); process.exit(2); }
    console.log('CJS OK');
  `;
  writeFileSync(join(consumerDir, 'smoke.cjs'), cjsSmoke);
  if (!run('node', ['smoke.cjs'], { cwd: consumerDir }).includes('CJS OK')) {
    fail('CommonJS smoke did not report OK');
  }
  console.log('[verify:pack] OK: CommonJS require exposes named exports');

  // 3. Native ESM import smoke.
  const esmSmoke = `
    import * as mod from '${pkg.name}';
    const missing = ${names}.filter((n) => typeof mod[n] !== 'function');
    if (missing.length) { console.error('ESM missing: ' + missing.join(', ')); process.exit(5); }
    console.log('ESM OK');
  `;
  writeFileSync(join(consumerDir, 'smoke.mjs'), esmSmoke);
  if (!run('node', ['smoke.mjs'], { cwd: consumerDir }).includes('ESM OK')) {
    fail('ESM smoke did not report OK');
  }
  console.log('[verify:pack] OK: ESM named imports resolve');

  // 4. The browser-safe subpath resolves, exposes its names, and never reaches for node: modules.
  const manifestSmoke = `
    const mod = require('${pkg.name}/manifest');
    const missing = ${JSON.stringify(EXPECTED_MANIFEST)}.filter((n) => typeof mod[n] !== 'function');
    if (missing.length) { console.error('manifest missing: ' + missing.join(', ')); process.exit(3); }
    console.log('MANIFEST OK');
  `;
  writeFileSync(join(consumerDir, 'manifest-smoke.cjs'), manifestSmoke);
  if (!run('node', ['manifest-smoke.cjs'], { cwd: consumerDir }).includes('MANIFEST OK')) {
    fail('manifest subpath smoke did not report OK');
  }
  const manifestSource = readFileSync(join(consumerDir, 'node_modules', pkg.name, 'dist', 'manifest.js'), 'utf8');
  if (/require\(['"](node:|fs|path|crypto|os|child_process)/.test(manifestSource)) {
    fail('dist/manifest.js imports a Node built-in; it must stay browser-safe');
  }
  console.log('[verify:pack] OK: ./manifest resolves and is free of Node built-ins');

  console.log('\n[verify:pack] PASS: all checks green');
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}
