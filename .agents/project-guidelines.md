# art-store-kit project guidelines

Content-addressed binary asset store: a committed SHA-256 manifest, rsync-backed publish and pull, and a verified append-only archive. Configured per repo by `art-store.config.json`; there are no fleet defaults in code.

This is a package in the shared fleet documented by `packages-meta`. Fleet-wide
architecture, maturity criteria, and composition rules live there; personal
workflow standards load from `agent_brain` via the directory tree.

## Source of truth

- This package's source and packed exports are authoritative for its behavior.
- `packages-meta` owns cross-package boundaries and the catalog entry.
- `STANDARDS.md`, `CONTRIBUTING.md`, and `RELEASING.md` in this repo govern
  code, contribution, and release mechanics.

## Rules

- The manifest file format and object naming are a compatibility commitment: consumers keep committed manifests and remote stores that must keep working unchanged. Change them only with a migration.
- `src/manifest.ts` is the browser-safe entry (`./manifest`): it must never import a `node:` module. `npm run verify:pack` fails if it does.
- No repo, host or path defaults in `src/`; every such value arrives through `art-store.config.json` or a function argument.
- Remote access (ssh, rsync) goes through an injectable runner so the logic is tested against a local fake remote.
- Keep the public API surface deliberate: every export is a compatibility
  commitment. Follow the release flow in `RELEASING.md` (patch-note fragments,
  version gates) for any user-visible change.
- Run `npm run verify` before calling work done.
