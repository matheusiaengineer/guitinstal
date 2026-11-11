# Release v0.7.14 — 2026-11-11

- Version: 0.7.14
- Notes: Optional AI troubleshooting and reviewed file-repair proposals
- Prepared by: npm run release (tools/release.js)
- Products: win32 x64, Node v26.2.0
- Files changed: README.md, app/CHANGELOG.md, app/README.md, app/core/assistant.js, app/core/engine/policy.js, app/core/secret-store.js, app/docs/UNIVERSAL-ENGINE.md, app/package-lock.json, app/package.json, app/server/api.js, app/ui/app.css, app/ui/app.js, app/ui/index.html, site/download.html, site/releases.json, app/core/ai-providers.js, app/core/ai.js, app/core/file-repair.js, app/tools/ai-selftest.js

## Assets

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| GUITinstal-0.7.14-Setup-x64.exe | 121864993 | `bc4ff5b6af24251fc8056be9b15c361a7750a34d0b3ffdee290adcde246cc8df` |
| GUITinstal-0.7.14-Portable-x64.exe | 110632155 | `f1861d1853e73785b98f1ca46a7b2540d1bffa291392a6145bff600d3f76761f` |

## Checks executed

| Check | Result | Seconds |
| --- | --- | ---: |
| syntax and catalog | pass | 4 |
| engine selftest | pass | 0 |
| plan selftest | pass | 1 |
| adapter coverage | pass | 0 |
| site/releases.json | pass | 1 |

## Publication state

- Site metadata version: 0.7.14
- GitHub release upload: **pending** (not performed by this command)
- Asset verification (HTTP 200 + digest): **pending**
- Vercel production deploy: **pending**

## Not run

- Adapter install proofs and the end-to-end smoke test were not run (use --full, or run them separately).
