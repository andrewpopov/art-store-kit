---
kind: changed
summary: art-store.config.json may omit the runtime store settings for archive-only repos
---

`publicRoot`, `manifest`, `hydratedRecord`, `trackedDir`, `extensions` and `store` are now an all-or-nothing group, so `archive` and `archive-pull` work with only an `archive` section. Runtime commands fail naming the missing settings. `ResolvedConfig` now holds the group under `runtime` (null when absent).
