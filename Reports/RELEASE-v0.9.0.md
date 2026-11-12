# Release v0.9.0 — 2026-11-12

- Version: 0.9.0
- Notes: Linux setup guidance, Xcode support, and installable PWA companion
- Prepared by: npm run release (tools/release.js)
- Products: win32 x64, Node v26.2.0
- Files changed: README.md, app/CHANGELOG.md, app/package-lock.json, app/package.json, app/tools/make-site-release.js, site/releases.json

## Assets

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| GUITinstal-0.9.0-Setup-x64.exe | 121880199 | `2ef7cf1167c62160a06f92f5cef5f25f6aebce6abed64f46da8a28997783fe72` |
| GUITinstal-0.9.0-Portable-x64.exe | 110633905 | `44de93ff286a541dce87d3b57e7db846662173ef684c30a6e722e3bd269940b4` |

## Checks executed

| Check | Result | Seconds |
| --- | --- | ---: |
| syntax and catalog | pass | 6 |
| engine selftest | pass | 0 |
| plan selftest | pass | 1 |
| adapter coverage | pass | 0 |
| site/releases.json | pass | 1 |

## Publication state

- Site metadata version: 0.9.0
- GitHub release upload: **complete** — https://github.com/matheusiaengineer/guitinstal/releases/tag/v0.9.0
- Setup installer: HTTP 200, 121,880,199 bytes, SHA-256 verified
- Portable installer: HTTP 200, 110,633,905 bytes, SHA-256 verified
- Vercel production deploy: **ready** — https://guitinstal.vercel.app
- macOS DMG and Linux AppImage: **pending** — GitHub Actions runners were blocked by an account billing lock; source ZIP fallbacks remain available.

## Not run

- Adapter install proofs and the end-to-end smoke test were not run (use --full, or run them separately).
