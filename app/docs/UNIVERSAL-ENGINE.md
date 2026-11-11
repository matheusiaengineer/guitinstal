# GUITinstal Universal Engine - final technology configuration

This is the configuration layer of the engine: the runtime catalog, the
requirements of each stack, the project categories, the compatibility rules,
the sixteen step workflow and the policies the app holds itself to.

It is **connected**. The compatibility engine is called by the plan builder and
its verdict decides which steps a plan contains; the runtime adapters in
`core/runtime-install.js` are the code behind the catalog's `implemented`
status. The existing plan, runner, library and interface keep working as they
did — what changed is that the map and the code are now the same thing.

Every entry that still says `planned` or `catalogued` is a promise the code has
not kept yet, and the report tool prints that list rather than hiding it.

## Files

| File | What it holds |
| --- | --- |
| `core/engine/catalog.json` | The runtime catalog: 34 runtimes, the ecosystems and the stacks |
| `core/engine/catalog.js` | Loads the catalog, answers questions about it, validates it |
| `core/engine/requirements.js` | Which runtimes a stack needs, in the order they have to exist |
| `core/engine/project-type.js` | The ten project categories and the launch model of each |
| `core/engine/compatibility.js` | Whether a runtime can live on this platform, and who has to install it |
| `core/engine/workflow.js` | The sixteen steps, the sixteen modules, and their measured status |
| `core/engine/policy.js` | Security rules, resource limits and platform support |
| `core/engine/index.js` | The public surface: config, summary, capabilities, validation |
| `tools/engine-report.js` | Prints and writes the coverage report |
| `tools/engine-selftest.js` | Tests the classifier, the compatibility rules and the catalog |

## The catalog

Each runtime carries everything the engine needs to install it and to prove it
worked:

```json
{
  "id": "php",
  "label": "PHP 8",
  "ecosystem": "php",
  "versions": { "supported": "8.2 - 8.5", "policy": "latest stable published by the vendor" },
  "officialSource": "https://windows.php.net/download/",
  "download": { "kind": "zip", "url": "https://downloads.php.net/~windows/releases/archives/", "resolvedAtRuntime": true },
  "platforms": {
    "win32": { "x64": "full", "arm64": "none" },
    "darwin": { "x64": "external", "arm64": "external" },
    "linux": { "x64": "external", "arm64": "external" }
  },
  "installerFormat": "zip",
  "checksum": { "algorithm": "sha256", "published": true, "where": "the download page publishes a digest per archive" },
  "signature": { "kind": "none", "verified": false, "where": "" },
  "destination": "<userData>/tools/php",
  "versionCommand": { "command": "php", "args": ["--version"] },
  "verification": "run the version command, then check that the extensions the project needs are loaded",
  "uninstall": "delete the destination folder; nothing outside <userData>/tools is touched",
  "installMode": "managed",
  "requiresAdmin": false,
  "requiresReboot": false,
  "needs": [],
  "status": "implemented"
}
```

### installMode - how a runtime can reach a machine

| Mode | Meaning |
| --- | --- |
| `managed` | GUITinstal downloads it from the official source, checks the published digest and installs it per user |
| `guided` | A human installs it from the official page. GUITstal shows the page and says why |
| `bundled` | It arrives with another runtime |
| `builtin` | It is part of another runtime |

### status - how far this has been built

| Status | Meaning |
| --- | --- |
| `implemented` | The app can install it today, and it is proven |
| `catalogued` | The entry is complete and the source is real, but there is no installer adapter yet |
| `external` | It cannot be installed by GUITstal at all. The reason is written in the entry |

### The rule that keeps this honest

A `managed` runtime **must** publish a checksum. The catalog validator fails
the build if one does not, because a managed install without a digest is
exactly the risk the project refuses to take.

## The sixteen steps

The workflow is fixed and always in this order.

| # | Step | Owner | Status |
| --- | --- | --- | --- |
| 1 | Validate | `core/repo-url.js`, `server/api.js` | implemented |
| 2 | Scan | `core/github.js`, `core/detect.js` | partial |
| 3 | Detect | `core/detect.js`, `core/engine/project-type.js` | implemented |
| 4 | Compatibility | `core/engine/compatibility.js`, `core/plan.js` | implemented |
| 5 | Runtime preparation | `core/runtime-install.js` | implemented |
| 6 | Installation plan | `core/plan.js` | implemented |
| 7 | User approval | `core/runner.js` | implemented |
| 8 | Download | `core/git.js`, `core/plan.js` | implemented |
| 9 | Environment | `core/plan.js` | partial |
| 10 | Dependencies | `core/plan.js` | implemented |
| 11 | Configuration | `core/secret-store.js`, `core/plan.js` | partial |
| 12 | Build | `core/plan.js` | implemented |
| 13 | Verification | `core/verify.js` | implemented |
| 14 | Register | `core/store.js` | implemented |
| 15 | Launch | `server/api.js`, `core/plan.js` | implemented |
| 16 | Complete | `ui/app.js` | implemented |

`planned` means the module exists as configuration and nothing calls it yet.
`partial` means it works for some stacks and not for others. The notes on each
step say which.

## How compatibility reaches the plan

The compatibility engine is not a report any more: the plan builder calls it,
and the verdict decides which steps the plan contains.

```
detected stack + package manager
        |
        v
compatibility.forProject({ stack, packageManager, available, adapters })
        |
        +-- ready        every runtime is on this machine
        +-- installable  a missing runtime has a real adapter in this build
        +-- guided       a missing runtime only a human can install
        +-- partial      the vendor ships an incomplete build for this processor
        +-- blocked      there is no build for this platform
```

- **installable** runtimes become `prepare-<id>` steps, in dependency order
  (PHP before Composer, rustup before Cargo).
- **guided** runtimes never become a step. The official page is attached to the
  plan and to the warning list.
- **blocked** marks every step that needs it, and `POST /api/runs` refuses the
  plan. The interface shows the reason and no Install button.
- **bundled/builtin** runtimes (npm, pip, venv, compose) are never a separate
  step: their host carries them.

The `adapters` argument is `adapterIds()` from `core/runtime-install.js`, the
list of adapters that really exist in this build. A catalog entry alone never
produces a button.

## The ten project categories

A repository is not a stack, it is a kind of thing, and the kind decides what
GUITinstal may offer to do with it.

| Category | Launch model | Actions |
| --- | --- | --- |
| Desktop application | `run-app` | install, run, stop, logs, open folder, update, uninstall |
| Web application | `open-in-browser` | install, run, open app, stop, logs, open folder, update, uninstall |
| Backend service | `start-stop` | install, run, stop, logs, open folder, update, uninstall |
| Command line tool | `run-command` | install, run, logs, open folder, update, uninstall |
| Library | `open-project` | install, docs, open folder, update, uninstall |
| Framework or extension | `configure-project` | install, configure, open folder, update, uninstall |
| Project template | `configure-project` | install, configure, open folder, update, uninstall |
| AI application | inherits the inner kind | install, run, open app, stop, logs, open folder, update, uninstall |
| AI skill or plugin | `install-in-host` | install in host, open folder, update, uninstall |
| Multi-service application | `start-stop` | install, run, stop, logs, open folder, update, uninstall |

When the evidence points nowhere, the answer is `unknown` plus a question. A
library never gets a Run button.

## Compatibility

Five verdicts, and the difference between them matters:

| Verdict | Meaning |
| --- | --- |
| `ready` | It is already on this machine |
| `installable` | GUITinstal can install it and verify what it downloads |
| `guided` | A human has to install it from the official page |
| `partial` | The vendor has a build for this platform, but it is incomplete |
| `blocked` | There is no build for this platform. It cannot work here |

A runtime that needs administrator rights is never `installable`. GUITstal does
not elevate itself, so Docker Desktop, MSBuild and Git for Windows stay
`guided` with the reason attached.

## Security

Fifteen rules, each one naming the file that enforces it. Thirteen are fully
enforced. Two are not, and they say so:

- **Signature verification** - the catalog records where a vendor publishes a
  digital signature, but the installer verifies the digest only.
- **Project secrets** - the `.env` guidance and the Laravel key generation
  exist. There is no general secret manager for other project credentials yet.

The local server binds to `127.0.0.1` on a random port and every request needs
the per-session token. The GitHub token is sealed with Windows DPAPI for this
user only; on other systems it lives in memory for the session and the app says
so. The assistant answers from local evidence by default. Optional external AI
providers are called only after per-request consent; a repair request additionally
sends the selected project file. Provider pricing and free quotas are not verified
by the app.

## API

All of them read the configuration. None of them install anything.

| Route | Method | Returns |
| --- | --- | --- |
| `/api/engine/config` | GET | The whole configuration |
| `/api/engine/summary` | GET | Coverage counts and what this machine can do |
| `/api/engine/catalog` | GET | The runtime catalog, the ecosystems and the stacks |
| `/api/engine/workflow` | GET | The sixteen steps, the sixteen modules and the gaps |
| `/api/engine/capabilities` | GET | The runtimes present, missing and installable here |
| `/api/engine/requirements` | POST | The requirements of a stack, `{ stack, packageManager }` |
| `/api/engine/classify` | POST | The category of a repository, `{ entries, manifests, repo }` |
| `/api/engine/validate` | POST | The catalog checked against itself and against the running app |

The classify route builds the detection itself. The browser may describe a
repository, but it does not get to describe the answer.

## Tools

```bash
node tools/engine-selftest.js        # 28 checks over the classifier and the catalog
node tools/plan-selftest.js          # 21 checks over compatibility -> plan
node tools/runtime-adapters-check.js # adapters vs catalog, offline
node tools/runtime-adapters-check.js --live   # each vendor's current release
node tools/install-proof.js install <id>      # real install + a functional test
node tools/install-proof.js persist           # restart: reuse everything, download nothing
node tools/install-proof.js repair <id>       # break one tool, prove it is repaired
node tools/engine-report.js          # the coverage report on screen
node tools/engine-report.js --write  # the report also written to Reports/
```

The report ends with the problems it found. An empty problem list means the
catalog and the application agree: every runtime the app can install is in the
catalog and marked `implemented`, and every runtime the app probes is known.

## What this does not do

- It does not install a runtime that has no adapter. Maven, Gradle, .NET, Ruby,
  Docker, MSYS2, Clang and the rest of the catalog stay guided installs with
  their official page attached, and the report says so.
- It does not make macOS or Linux support claims. The adapters are Windows
  only: on another platform `supportedIds()` is empty and every runtime is a
  guided install.
- It does not elevate. A runtime that needs administrator rights is guided by
  definition, and the installer never writes to the registry or the system
  PATH.

## Runtime adapters

`core/runtime-install.js` has ten adapters. Each one resolves the release from
the vendor's own index, verifies a digest, unpacks into `<userData>/tools/<id>`
and proves the tool runs before the step is called done. Nine of them read the
digest the vendor publishes; `git` pins one (see below).

| Adapter | Source resolved at install time | Digest |
| --- | --- | --- |
| `node` | `nodejs.org/dist/index.json` + `SHASUMS256.txt` | sha256 |
| `python` | `astral-sh/python-build-standalone` release + `SHA256SUMS` | sha256 |
| `go` | `go.dev/dl/?mode=json` | sha256 |
| `java` | `api.adoptium.net` (Temurin JDK 21) | sha256 |
| `uv` | `astral-sh/uv` release + `.sha256` | sha256 |
| `bun` | `oven-sh/bun` release + `SHASUMS256.txt` | sha256 |
| `php` | `windows.php.net/download` | sha256 |
| `composer` | `getcomposer.org` `.sha256sum` | sha256 |
| `rustup` | `static.rust-lang.org` `.sha256` | sha256 |
| `git` | pinned `MinGit` release of `git-for-windows/git` | sha256, pinned |

`rustup` provides both `rustup` and `cargo`; `node` provides `node` and `npm`;
`python` provides `python` and `pip`, so the plan asks for the tool it runs and
the engine never asks for a second installer for a bundled tool.

### Git

Git is the one runtime every install depends on, and the one Windows does not
ship. The adapter installs the official **MinGit** portable build into
`<userData>/tools/git`; nothing is written to PATH, the registry or Program
Files, and no administrator is involved.

Two details matter and both are easy to get wrong:

- Git for Windows publishes no checksum file next to `MinGit-*.zip`. The build
  therefore pins one exact release and its digest (`MINGIT` in
  `core/runtime-install.js`), and the catalog validator reports a pinned digest
  as a warning instead of letting it look published. Updating Git is a code
  change with a new digest and a fresh clone proof — never a silent "latest".
- `ucrt64/bin/git.exe` cannot clone over HTTPS on its own: it answers
  `unable to find remote helper for 'https'`. The `cmd/git.exe` wrapper sets up
the environment MinGit expects, so that wrapper is the binary the engine
resolves and the one the install proof clones with. `unpackInto` is not used
here, because it would take `cmd/` as the tool root and discard `ucrt64/`,
`usr/` and `etc/`.

Rust needs a linker after `rustc` runs. The MSVC toolchain borrows Visual
Studio's `link.exe`, which needs an administrator and is not something this app
may install. So the adapter compiles and links a one-line program after the
install; when that fails because no linker exists, it installs the GNU
toolchain (which carries its own linker) and makes it the default. A Rust that
cannot link is not called installed.

An archive is unpacked whole. When the executable lives in `bin/`, the folder
above it becomes the tool root: taking `bin/` as the root would keep `go.exe`
and discard `pkg/` and `src/`, or keep `java.exe` and discard `lib/` and
`conf/` — tools that start once and fail at their first real job.

## Proving an adapter for real

The adapter check resolves metadata; it does not install anything. The proof
driver does, and it then uses the tool for the job the plan will ask of it:

```bash
GUITINSTAL_USER_DATA=<scratch folder> node tools/install-proof.js install python
GUITINSTAL_USER_DATA=<scratch folder> node tools/install-proof.js persist
GUITINSTAL_USER_DATA=<scratch folder> node tools/install-proof.js repair composer
```

`install <id>` downloads, verifies the digest, unpacks, checks the version and
runs a dependent workflow (virtual environment and a package, `go build` and
the resulting program, `javac` and `java`, `uv sync` with the managed Python,
`bun install`, a PHP server answering HTTP, `composer install` with a real
autoload, `cargo build` and the binary). `persist` is the restart: a fresh
process must reuse every tool and download nothing. `repair` breaks one tool
on purpose and proves the next install heals it.

## Adding a runtime

1. Add the entry to `core/engine/catalog.json`, with every field filled in.
2. Add the id to its ecosystem, and the ecosystem to `core/engine/catalog.json`
   if it is new.
3. Add the stack to `stacks` if the runtime belongs to one.
4. Run `node tools/engine-report.js`. The validator rejects an entry without a
   checksum, without an official source, with a dangling dependency or with a
   dependency loop.
5. When the installer adapter exists, add it to `core/runtime-install.js` and
   set the status to `implemented`.
