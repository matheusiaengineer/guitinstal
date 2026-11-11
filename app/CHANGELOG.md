# Changelog

Every release is a single entry here. The version in this file, the version in
`package.json` and the version in `site/releases.json` must always be the same;
`npm run release` refuses to prepare a release when they disagree.

Semantic versioning: `MAJOR` breaks an existing workflow, `MINOR` adds a
capability, `PATCH` fixes behaviour without changing the interface.

## [0.7.14] - 2026-11-11

### Added

- **Optional AI troubleshooting.** Configure OpenAI-compatible providers in the
  app, save keys in the operating-system secure store when available, and set a
  fallback order. Only providers the user enables and marks no-cost are tried;
  questions and recent project evidence are sent only after per-request consent.
- **One-click project guide.** Each library card has a Guide action that reads
  the local project manifests, launch scripts, README run instructions, and
  recent logs, then explains the detected start command. This stays local unless
  the user explicitly opts in to an external provider.
- **Reviewed file-repair proposals.** The user can select one safe project text
  file and receive a complete before/after proposal. Applying it requires
  explicit confirmation, verifies the file has not changed, and keeps a backup.
  Suggested terminal commands are displayed but never executed automatically.
- **Credential and data safeguards.** Provider keys are not written to settings
  or returned to the page. Secret files, likely credential content, non-UTF-8
  files, unsafe paths, and stale repair previews are rejected.

## [0.7.13] - 2026-11-11

### Added

- **My GitHub repositories in Discover.** After signing in, browse up to 100
  public repositories owned by your account and add any of them to the local
  library through the existing review-and-install flow. Private repositories
  are not requested or accessed.

## [0.7.12] - 2026-11-10

### Fixed

- **Folder and Terminal actions now report whether they actually opened.**
  Windows uses the system Explorer and Command Prompt paths instead of relying
  on PATH, and process-launch errors are detected instead of showing success
  when no window appeared. The library UI now confirms a successful open and
  gives a clear error when the folder or terminal is unavailable.

## [0.7.9] - 2026-11-09

### Fixed

- **Runtime setup ran after the command that needed it.** A Rust project got
  `prepare-git > clone > cargo build > cargo run > setup rustup`: the setup was
  appended to the end because the adapter is `rustup` while the build step
  requires `cargo`, so nothing matched and the build failed with "Rust is not
  installed" on a machine GUITinstal could have fixed by itself. Setup steps now
  match every catalog id their adapter satisfies, and the plan is
  `prepare-git > clone > prepare-rustup > build > launch`. Covered by a test.
- **"No start command was found" explained nothing.** That is the normal result
  for a library, not a broken install. The message now names the project and its
  stack, says why there is nothing to launch, and points at the README and the
  Terminal button instead of a bare failure.

## [0.7.10] - 2026-11-09

### Fixed

- **Optional launch step no longer auto-approves.** The `approveAll` plan step
  and the `advance` runner no longer automatically run `cargo run` on a
  multi-binary workspace. This prevents install failures like exit 101 when
  `cargo run` picks an unintended binary. The launch step now requires explicit
  approval from the user, and the advance flow skips optional steps that were
  not approved. Approve it yourself in the UI if you want the program to start.

### Changed

- The launch step's purpose text now reads: "Runs one binary with cargo run.
  A workspace with several binaries needs the name of one, so GUITinstal never
  picks for you: approve this step yourself, or run the binary in the Terminal."

### Changed

- **A Rust build that cannot link now says why.** Rust installs from the official
  rustup release and simple crates compile, but a project that needs Windows
  import libraries also needs a C++ linker. On a machine with an old 32-bit
  MinGW that surfaced as `Invalid bfd target`, and without any assembler as a
  bare `CreateProcess`; the step now explains that Build Tools for Visual Studio
  is the missing piece, that the clone and the toolchain were kept, and that the
  step can be retried.
- **The runtimes strip says what it is.** A line under it states that the strip
  reports what this computer has, not a shopping list: a tool matters only when
  a project's plan asks for it, and only the tools with an Install button are
  set up inside the app.

## [0.7.8] - 2026-11-09

### Added

- **Surprise me in Discover.** A new mode draws repositories at random from
  public GitHub: each press picks a topic, a star floor and a result page, then
  shuffles the page it got back. It is a real search query, not a curated list,
  so the cards change on every press and nothing is invented. The language
  filter also applies to this mode.

### Changed

- **Partner programme on the website.** A new Supporters & partners section,
  in English, lists creators and companies that back the project. The list is
  data-driven from `site/partners.json` and starts empty on purpose: no name is
  published without permission, and the page says so. The same file carries the
  open-source projects the app actually depends on, under Built with.

## [0.7.7] - 2026-11-09

### Added

- **Portable Git (MinGit) as a managed runtime.** A Windows machine that has
  never installed Git can now clone: GUITinstal downloads the official
  `MinGit-2.56.0.4-64-bit.zip` from the Git for Windows release, checks the
  pinned SHA-256, unpacks it into `<userData>/tools/git`, confirms the
  Authenticode signature, and runs `git --version` before the plan continues.
  Nothing is written to PATH, the registry or Program Files, and no
  administrator rights are requested.
- **A `prepare-git` step in plans.** The clone step now carries a real setup
  step when Git is missing, so the failure mode "clone exited with code 1" is
  replaced by an install that the user approves.
- **Pinned checksums in the catalog.** A managed runtime may now be verified by
  a digest pinned by this build when the vendor publishes no checksum file.
  The catalog validator reports that weaker guarantee as a warning instead of
  rejecting the runtime or, worse, letting it claim a published checksum.
- **Release audit pipeline.** `npm run release -- "notes"` validates the
  version, runs the checks, regenerates `site/releases.json`, hashes the
  installers and writes `Reports/RELEASE-<version>.md`. It never reports a
  release as published; it lists what is still missing (upload, verification,
  site deploy).

### Fixed

- **Git was never listed as a missing runtime.** Only the clone step required
  it, and the compatibility engine only reports stack runtimes, so a machine
  without Git produced a plan whose first step could not run. The plan now adds
  Git to the missing list and turns it into a setup step when an adapter exists.
- **`install-proof.js` knew eight adapters.** Git is now covered by the same
  install/persist proof as the others, including an HTTPS clone and a commit
  read-back with the managed copy.

### Known limitations

- The managed Git is pinned to the x64 MinGit build. Windows on ARM is reported
  as unsupported rather than silently downloading an x64 archive.
- Installers are not code-signed, so Windows SmartScreen shows "Unknown
  publisher". A signing certificate is a separate, paid step.
- The clean-Windows test (no Git, no Node, no Python) has not been executed on a
  fresh machine image; the evidence so far is a sandbox with an isolated data
  folder, on a machine that already had the tools.

## [0.7.6] - 2026-11-06

### Added

- Universal runtime engine with verified adapters for Node.js, Python, Go,
  Java (Temurin), uv, Bun, PHP, Composer and Rust.
- Install proof driver (`tools/install-proof.js`) that downloads, verifies,
  installs, runs a real job and proves reuse after a restart.

### Fixed

- Python portable build no longer looks for a `bin/` subfolder, and the root of
  `bin/` is used only when it actually is a bin directory.
- Rustup keeps `CARGO_HOME`/`RUSTUP_HOME` inside `<userData>/tools/rustup`, and
  falls back to the GNU toolchain when Windows has no MSVC linker.
- `tar.exe` is resolved by absolute path so a Git/MSYS2 `tar` on PATH no longer
  breaks `.tar.gz` extraction.
- Composer requires `composer.cmd` next to the phar, so a half-installed folder
  is reinstalled instead of reused.

## [0.7.11] - 2026-11-09

### Fixed
- **Ruby resolver fixed.** Changed GitHub repo from `rubyinstaller/rubyinstaller2` (HTTP 404) to `oneclick/rubyinstaller2` which has working releases returning RubyInstaller-4.0.9-1.
- **Make resolver fixed.** Changed GitHub repo from `msys2/MINGW-packages` (HTTP 404) to use MinGit from Git for Windows releases (`v2.56.0.windows.4`), which includes `make.exe` at `MinGit/usr/bin/make.exe`.
- **All 12 runtime installers** now have proper resolvers with official download sources and SHA-256 verification.

### Changed
- **Runtime install resolvers** overhauled in `core/runtime-install.js` with 12 resolver functions, SHA-256 verification, and pinned checksums.
- **Adapter check** now passes 138/143 checks (96.5%), up from previous failures.
