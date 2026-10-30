# Changelog

## 0.1.1

- art-store.config.json may omit the runtime store settings for archive-only repos
  `publicRoot`, `manifest`, `hydratedRecord`, `trackedDir`, `extensions` and `store` are now an all-or-nothing group, so `archive` and `archive-pull` work with only an `archive` section. Runtime commands fail naming the missing settings. `ResolvedConfig` now holds the group under `runtime` (null when absent).

## 0.1.0

- Initial art-store-kit - content-addressed runtime art store (manifest, pull, publish) and verified archive, configured by art-store.config.json
  Extracted from towerpower's runtime-art scripts and jun's masters.sh. The `.` entry point is Node-only; `./manifest` is browser-safe.
