# art-store-kit

Content-addressed binary asset store: a committed SHA-256 manifest, rsync-backed publish and pull, and a verified append-only archive. Extracted from towerpower's runtime-art scripts and jun's `masters.sh`; every repo, host and path arrives through `art-store.config.json`, with no defaults in code.

Install from a git tag: `npm install github:andrewpopov/art-store-kit#v<version>`.

## Entry points

- `@andrewpopov/art-store-kit` - Node: manifest build/serialize, store, materialize, verify, pull, rsync command builders, `archive`/`archivePull`, config loading, `main`.
- `@andrewpopov/art-store-kit/manifest` - browser-safe (no `node:` imports, enforced by `npm run verify:pack`): `parseArtManifest`, `artObjectName`, `isArtObjectName`, `isArtExtension`, `ART_HASH_HEX_LENGTH`, and the `ArtManifest` / `ArtLayout` types. Use it from web bundles.

## Config

`art-store.config.json` at the repo root (found from the cwd upward). Paths are relative to the file.

```json
{
  "publicRoot": "apps/web/public",
  "manifest": "apps/web/src/game/data/runtimeArtManifest.json",
  "hydratedRecord": ".art-hydrated.json",
  "trackedDir": "art",
  "extensions": ["webp", "png", "jpg", "jpeg", "gif", "svg"],
  "store": { "dir": ".art-store", "machineCache": "towerpower/art-store" },
  "publish": { "host": "user@example-host", "projectDir": "/srv/app" },
  "archive": {
    "remote": "example-host",
    "root": "/mnt/backup/art-archive/jun/design-src",
    "requireMount": "/mnt/backup",
    "snapshotPrefix": "masters",
    "sourceDir": "apps/web/design-src",
    "extensions": ["png"],
    "manifest": "apps/web/design-src/masters.sha256"
  }
}
```

`store.dir` is the local object store (in a worktree it resolves to the owning checkout's copy); in a lane-broker remote snapshot it is `$XDG_CACHE_HOME/<machineCache>` (default `~/.cache`). `ART_STORE_DIR` overrides both. The remote store lives at `<publish.projectDir>/<basename of store.dir>`. `publish` and `archive` are only needed by the commands that use them.

The runtime settings (`publicRoot`, `manifest`, `hydratedRecord`, `trackedDir`, `extensions`, `store`) are one all-or-nothing group. A repo that only uses `archive` / `archive-pull` can omit all six and give just `archive`; a config with neither the group nor `archive` is an error, a partial group is an error, and `manifest`, `pull`, `check-untracked`, `materialize`, `verify-store` and `publish` fail naming the missing runtime settings. `publish` also requires the group.

## Commands

`art-store <command>`, flags `--store`, `--manifest`, `--public-root`, `--hydrated-record` override the config.

- `manifest [--check] [--add paths] [--remove keys] [--take-local keys]` - rewrite the manifest from local edits, or check local files against it.
- `pull [--repair] [--discard-local] [--dry-run]` - hydrate files from the store, fetching missing objects over rsync. In a lane snapshot files are hardlinked from the store.
- `check-untracked` - fail if git tracks images under `<publicRoot>/<trackedDir>`.
- `materialize` / `verify-store` - copy manifested files into the store / re-hash the store.
- `publish [--repair] [--dry-run]` - rsync the store to the publish target and verify by checksum.
- `archive` / `archive-pull [prefix]` - see below.

## Archive

For large masters that are gitignored: objects land in `<root>/objects/<sha256>.<ext>`, every run also writes `<root>/manifests/<snapshotPrefix>-<UTC yyyymmddThhmmssZ>.sha256` (no-clobber), and the committed manifest is in `sha256sum` format (`<sha>  <path>`, bytewise-sorted). `archive` refuses unless `requireMount` is a mountpoint on the remote, uploads with `--ignore-existing`, re-hashes every object on the remote (`sha256sum -c`), and only then replaces the committed manifest. `archive-pull` fetches missing or mismatched files and re-verifies every selected path, exiting 1 and naming any that fail.

## Not included

towerpower's `archive-art.py` snapshot flow is not ported; it stays in towerpower for now. Consumers have not migrated yet.

## Development

`npm run verify` runs typecheck, tests, compile, dist-freshness and pack checks. `dist/` is committed.
