'use strict';

/**
 * Runtime Manager: the part that turns a "missing" chip into an installed tool.
 *
 * Three rules shape this file. Every artifact comes from the project's own
 * download site over HTTPS, resolved at install time so the version is the one
 * the vendor publishes today. Every artifact is checked against the digest
 * that same site publishes before it is ever executed. And GUITinstal never
 * runs a "curl | sh" style installer and never touches the system PATH or the
 * registry: tools land in <userData>/tools and are handed to child processes
 * through tools.js, so uninstalling is deleting a folder.
 *
 * A runtime in the catalog is not an installer. Only the entries in TOOLBOX
 * below can put software on a machine, and `supportedIds()` is the list the
 * compatibility engine and the plan builder ask for. Everything else is a
 * guided install with the official page attached.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');

const { userDataDir, ensureDir } = require('./paths');

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const isWindows = process.platform === 'win32';

function toolsRoot() {
  return path.join(userDataDir(), 'tools');
}

function manifestFile() {
  return path.join(toolsRoot(), 'manifest.json');
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeManifest(entry) {
  const file = manifestFile();
  ensureDir(path.dirname(file));
  const all = readManifest();
  all[entry.id] = entry;
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

/**
 * The folder one tool lives in, used to find its files without a PATH scan.
 * rustup installs into the user's own ~/.cargo, because that is where the
 * Rust toolchain looks for itself.
 */
function managedToolDir(id) {
  // rustup keeps two folders: the toolchain in RUSTUP_HOME and cargo.exe in
  // CARGO_HOME/bin. Both live inside <userData>/tools here, so installing Rust
  // never reads or writes the user's own ~/.cargo and uninstalling stays one
  // folder deletion.
  if (id === 'rustup' || id === 'cargo') {
    return path.join(toolsRoot(), 'rustup');
  }
  return path.join(toolsRoot(), id);
}

/** Folders GUITinstal installed tools live in, in PATH order. */
function managedToolDirs() {
  if (!isWindows) return [];
  const dirs = [];
  for (const id of Object.keys(TOOLBOX)) {
    const tool = TOOLBOX[id];
    const dir = path.join(managedToolDir(id), tool.binSubdir || '');
    if (fs.existsSync(dir) && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

function getText(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: { 'user-agent': 'GUITinstal', accept: 'application/json, text/plain, */*' },
          timeout: 25000,
        },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            if (hops >= 5) return reject(new Error(`too many redirects for ${url}`));
            return resolve(getText(new URL(res.headers.location, url).toString(), hops + 1));
          }
          if (res.statusCode !== 200) {
            res.resume();
            if (res.statusCode === 403 && /api\.github\.com/.test(url)) {
              return reject(
                new Error(
                  `${url} answered HTTP 403. The GitHub API allows 60 anonymous requests an hour; wait a few minutes and try again.`
                )
              );
            }
            return reject(new Error(`${url} answered HTTP ${res.statusCode}`));
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve(body));
        }
      )
      .on('error', reject);
  });
}

async function getJson(url) {
  const text = await getText(url);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} did not answer with JSON`);
  }
}

function download(url, dest, hops = 0, onProgress, signal) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'GUITinstal' }, timeout: 60000, signal }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (hops >= 5) return reject(new Error(`too many redirects for ${url}`));
          return resolve(download(new URL(res.headers.location, url).toString(), dest, hops + 1, onProgress, signal));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`${url} answered HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          got += chunk.length;
          if (onProgress && got % 4_000_000 < chunk.length) {
            onProgress(`downloaded ${(got / 1024 / 1024).toFixed(1)} MB${total ? ` of ${(total / 1024 / 1024).toFixed(1)} MB` : ''}`);
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(got)));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** Vendor installers are .exe; running one needs a real console-free spawn. */
function run(file, args, onLine, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      cwd: cwd || path.dirname(file),
      env: env ? { ...process.env, ...env } : process.env,
    });
    const push = (buf) =>
      String(buf || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => onLine && onLine(line));
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited with code ${code}`))));
  });
}

/** Finds a file by name inside an extracted tree, breadth first. */
function findFile(root, name, depth = 4) {
  const wanted = name.toLowerCase();
  let level = [root];
  for (let step = 0; step <= depth && level.length; step += 1) {
    const next = [];
    for (const dir of level) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === wanted) return full;
        if (entry.isDirectory()) next.push(full);
      }
    }
    level = next;
  }
  return '';
}

/** Moves every entry of `from` into `to`, tolerating a different drive. */
function moveContents(from, to) {
  ensureDir(to);
  for (const entry of fs.readdirSync(from)) {
    const source = path.join(from, entry);
    const target = path.join(to, entry);
    try {
      fs.renameSync(source, target);
    } catch {
      fs.cpSync(source, target, { recursive: true });
      fs.rmSync(source, { recursive: true, force: true });
    }
  }
}

/**
 * Unpacks a vendor archive. ZIP goes through PowerShell and tar.gz through the
 * tar.exe that ships with Windows 10 and 11; neither needs a package manager,
 * an administrator or an extra dependency.
 */
function extractZip(zip, dest) {
  ensureDir(dest);
  const quotePowerShell = (value) => String(value).replace(/'/g, "''");
  return run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${quotePowerShell(zip)}' -DestinationPath '${quotePowerShell(dest)}' -Force`,
    ],
    null
  );
}

/**
 * The tar that ships with Windows 10/11. Resolving it by absolute path matters:
 * a machine with Git for Windows or MSYS2 in PATH exposes its own tar.exe
 * first, and that one reads "C:\\..." as a remote host and fails with code 2.
 */
function systemTar() {
  const candidate = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(candidate) ? candidate : 'tar.exe';
}

function extractTarGz(file, dest) {
  ensureDir(dest);
  return run(systemTar(), ['-xzf', file, '-C', dest], null);
}

function extractArchive(file, dest) {
  const name = file.toLowerCase();
  if (name.endsWith('.zip')) return extractZip(file, dest);
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return extractTarGz(file, dest);
  throw new Error(`GUITinstal cannot unpack ${path.basename(file)}; only .zip and .tar.gz are supported`);
}

/**
 * Unpacks an archive into <userData>/tools/<id>, keeping the folder that holds
 * `mustFind` as the tool root. A failed unpack never leaves a half-installed
 * folder behind: the previous copy is only removed once the new one is located.
 */
async function unpackInto(file, id, mustFind) {
  const target = path.join(toolsRoot(), id);
  const stage = path.join(toolsRoot(), '.stage', `${id}-${Date.now()}`);
  ensureDir(stage);
  try {
    await extractArchive(file, stage);
    const located = findFile(stage, mustFind, 4);
    if (!located) throw new Error(`the archive GUITinstal downloaded does not contain ${mustFind}`);
    // Archives either put the executable at their root (Node.js, PHP, uv) or in
    // bin/ (Go, the JDK, portable CPython). Taking bin/ as the root would keep
    // go.exe and throw away pkg/ and src/, keep java.exe and throw away lib/ and
    // conf/ — the tools would start and then fail on their first real job.
    let root = path.dirname(located);
    if (path.basename(root).toLowerCase() === 'bin') root = path.dirname(root);
    const fresh = `${target}.new-${Date.now()}`;
    ensureDir(fresh);
    moveContents(root, fresh);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(fresh, target);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  const bin = findFile(target, mustFind, 4);
  if (!bin) throw new Error(`${mustFind} is not in ${target} after unpacking`);
  return { bin, dir: target };
}

/* ------------------------------------------------------------------ */
/* PHP                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Extensions every PHP project GUITinstal supports actually needs. Composer
 * itself needs openssl and zip; Laravel needs mbstring and openssl; SQLite is
 * the database the app configures for it. The official Windows zip ships a
 * php.ini-development with every one of these commented out, so unpacking the
 * archive alone produces a PHP that cannot install anything.
 */
const PHP_EXTENSIONS = ['curl', 'fileinfo', 'mbstring', 'openssl', 'pdo_sqlite', 'sqlite3', 'zip'];
const PHP_OPTIONAL_EXTENSIONS = ['gd', 'intl'];

function phpDll(dir, name) {
  for (const file of [`php_${name}.dll`, `${name}.dll`]) {
    const candidate = path.join(dir, 'ext', file);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function phpIniTemplate(dir) {
  for (const name of ['php.ini-development', 'php.ini-production']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * Writes the php.ini that makes the managed PHP usable, derived from the
 * official template so every unrelated setting keeps the vendor default.
 * A php.ini without our marker is left alone: it belongs to the user.
 */
function writePhpIni(dir, onLine) {
  const ini = path.join(dir, 'php.ini');
  if (fs.existsSync(ini)) {
    let current = '';
    try {
      current = fs.readFileSync(ini, 'utf8');
    } catch {
      return ini;
    }
    if (!current.includes('; GUITinstal managed php.ini')) return ini;
  }

  const template = phpIniTemplate(dir);
  let lines = [];
  if (template) {
    lines = fs.readFileSync(template, 'utf8').split(/\r?\n/);
  }

  const extDir = path.join(dir, 'ext').replace(/\\/g, '/');
  const enabled = PHP_EXTENSIONS.filter((name) => phpDll(dir, name));
  for (const name of PHP_OPTIONAL_EXTENSIONS) {
    if (phpDll(dir, name)) enabled.push(name);
  }
  const wanted = new Set(enabled.map((name) => name.toLowerCase()));
  const seen = new Set();
  let extensionDirDone = false;
  let timezoneDone = false;
  let memoryDone = false;
  let executionDone = false;

  const mapped = lines.map((line) => {
    if (/^\s*;?\s*extension_dir\s*=/i.test(line)) {
      extensionDirDone = true;
      return `extension_dir = "${extDir}"`;
    }
    const ext = /^\s*;\s*extension\s*=\s*"?([A-Za-z0-9_.-]+)"?\s*$/.exec(line);
    if (ext && wanted.has(ext[1].toLowerCase())) {
      seen.add(ext[1].toLowerCase());
      return `extension=${ext[1]}`;
    }
    if (/^\s*;?\s*date\.timezone\s*=/i.test(line)) {
      timezoneDone = true;
      return 'date.timezone = UTC';
    }
    if (/^\s*;?\s*memory_limit\s*=/i.test(line)) {
      memoryDone = true;
      return 'memory_limit = 1024M';
    }
    if (/^\s*;?\s*max_execution_time\s*=/i.test(line)) {
      executionDone = true;
      return 'max_execution_time = 0';
    }
    return line;
  });

  const extra = [];
  if (!extensionDirDone) extra.push(`extension_dir = "${extDir}"`);
  if (!timezoneDone) extra.push('date.timezone = UTC');
  if (!memoryDone) extra.push('memory_limit = 1024M');
  if (!executionDone) extra.push('max_execution_time = 0');
  for (const name of enabled) {
    if (!seen.has(name.toLowerCase())) extra.push(`extension=${name}`);
  }

  const content = [
    '; GUITinstal managed php.ini',
    '; Generated from the official PHP template. Delete this file to start over.',
    '',
    ...mapped,
    ...(extra.length ? ['', '; Added by GUITinstal', ...extra] : []),
    '',
  ].join('\n');
  fs.writeFileSync(ini, content, 'utf8');
  onLine(`php.ini written (extensions: ${enabled.join(', ') || 'built-in only'})`);
  return ini;
}

function capture(file, args, timeout = 25000, env) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn(file, args, {
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: out.replace(/\u001b\[[0-9;]*m/g, '').trim() });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* the process may have already exited */
      }
      done(-1);
    }, timeout);
    timer.unref?.();
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', () => done(-1));
    child.on('close', (code) => done(code));
  });
}

/** Proves the managed PHP loaded the extensions Composer and Laravel need. */
async function verifyPhpExtensions(dir) {
  const php = path.join(dir, 'php.exe');
  const result = await capture(php, ['-m'], 30000);
  if (result.code !== 0) {
    throw new Error(`the managed PHP could not list its modules${result.out ? `: ${result.out.split(/\r?\n/)[0]}` : ''}`);
  }
  const modules = new Set(result.out.split(/\r?\n/).map((line) => line.trim().toLowerCase()));
  const missing = PHP_EXTENSIONS.filter((name) => !modules.has(name.toLowerCase()));
  if (missing.length) {
    throw new Error(
      `the managed PHP is missing ${missing.join(', ')}. Delete ${path.join(toolsRoot(), 'php')} and install PHP again from the runtime panel.`
    );
  }
}

/** Points the PHP of a managed tool folder at its own ext directory. */
async function configurePhp(dir, onLine) {
  writePhpIni(dir, onLine);
  await verifyPhpExtensions(dir);
}

/* ------------------------------------------------------------------ */
/* Official release metadata                                           */
/*                                                                     */
/* Every resolver reads the vendor's own release index and returns the  */
/* URL together with the digest that index publishes. Nothing here      */
/* contains a hard-coded version, URL or hash: a stale pin would be a   */
/* silent lie the first time the vendor moves.                          */
/* ------------------------------------------------------------------ */

function requireSha256(value, source) {
  const digest = String(value || '').trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${source} did not publish a usable sha256`);
  return digest;
}

function compareVersions(a, b) {
  const left = String(a).replace(/^v/, '').split('.').map((part) => Number(part.replace(/\D.*$/, '')) || 0);
  const right = String(b).replace(/^v/, '').split('.').map((part) => Number(part.replace(/\D.*$/, '')) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

async function githubRelease(slug) {
  const release = await getJson(`https://api.github.com/repos/${slug}/releases/latest`);
  if (!Array.isArray(release?.assets) || !release.assets.length) {
    throw new Error(`${slug} did not publish a release with downloadable assets`);
  }
  return release;
}

/** Reads one hash out of a SHA256SUMS style file. */
async function hashFromSums(url, fileName) {
  const text = await getText(url);
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.endsWith(fileName) || item.endsWith(`*${fileName}`));
  if (!line) throw new Error(`${url} does not list ${fileName}`);
  return requireSha256(line, url);
}

async function resolvePhp() {
  const page = await getText('https://windows.php.net/download/');
  const rows = [...page.matchAll(/<p>[\s\S]*?<\/p>/g)]
    .map((m) => m[0])
    .map((block) => {
      const file = (block.match(new RegExp(`php-(8\\.\\d+\\.\\d+)-1-nts-Win32-vs\\d+-${arch}\\.zip`)) || [])[0];
      const hash = (block.match(/([0-9a-f]{64})/) || [])[1];
      return file && hash ? { file, hash } : null;
    })
    .filter(Boolean);
  if (!rows.length) throw new Error(`no PHP 8 NTS ${arch} build with a published checksum on windows.php.net`);
  const best = rows.sort((a, b) => b.file.localeCompare(a.file, 'en', { numeric: true }))[0];
  return {
    url: `https://downloads.php.net/~windows/releases/archives/${best.file}`,
    sha256: best.hash,
    file: best.file,
    version: best.file.match(/php-(\d+\.\d+\.\d+)/)[1],
  };
}

async function resolveComposer() {
  const line = (await getText('https://getcomposer.org/download/latest-stable/composer.phar.sha256sum')).trim();
  const [hash, name] = line.split(/\s+/);
  return {
    url: 'https://getcomposer.org/download/latest-stable/composer.phar',
    sha256: requireSha256(hash, 'getcomposer.org'),
    file: name || 'composer.phar',
  };
}

async function resolveRustup() {
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const base = `https://static.rust-lang.org/rustup/dist/${triple}/rustup-init.exe`;
  const hash = (await getText(`${base}.sha256`)).trim();
  return { url: base, sha256: requireSha256(hash, 'rust-lang.org'), file: 'rustup-init.exe' };
}

/**
 * Node.js publishes its release index and a SHASUMS256.txt next to every
 * version. The index only lists which platforms a release ships, so the digest
 * is read from the checksum file instead of guessed from the index.
 */
async function resolveNode() {
  const list = await getJson('https://nodejs.org/dist/index.json');
  if (!Array.isArray(list) || !list.length) throw new Error('nodejs.org did not return its release index');
  const wanted = arch === 'arm64' ? 'arm64' : 'x64';
  const shipsWindows = (item) => (item.files || []).some((file) => String(file.filename || file).includes(`win-${wanted}`));
  const pick =
    list.find((item) => item.lts && shipsWindows(item)) || list.find(shipsWindows) || null;
  if (!pick) throw new Error(`nodejs.org published no Windows ${wanted} build`);
  const name = `node-${pick.version}-win-${wanted}.zip`;
  const sha256 = await hashFromSums(`https://nodejs.org/dist/${pick.version}/SHASUMS256.txt`, name);
  return {
    url: `https://nodejs.org/dist/${pick.version}/${name}`,
    sha256,
    file: name,
    version: String(pick.version).replace(/^v/, ''),
  };
}

/** go.dev publishes a JSON index with the sha256 of every archive. */
async function resolveGo() {
  const list = await getJson('https://go.dev/dl/?mode=json');
  const latest = Array.isArray(list) ? list[0] : null;
  if (!latest) throw new Error('go.dev did not return its release index');
  const wanted = arch === 'arm64' ? 'arm64' : 'amd64';
  const file = (latest.files || []).find(
    (item) => item.os === 'windows' && item.arch === wanted && item.kind === 'archive' && /\.zip$/i.test(item.filename)
  );
  if (!file?.sha256) throw new Error(`go.dev published no windows ${wanted} archive with a sha256`);
  return {
    url: `https://go.dev/dl/${file.filename}`,
    sha256: requireSha256(file.sha256, 'go.dev'),
    file: file.filename,
    version: String(latest.version || '').replace(/^go/, ''),
  };
}

/** Eclipse Temurin (Adoptium) answers with the link and the checksum. */
async function resolveJava() {
  const wanted = arch === 'arm64' ? 'aarch64' : 'x64';
  const url = `https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=${wanted}&image_type=jdk&os=windows&vendor=eclipse`;
  const assets = await getJson(url);
  const pkg = Array.isArray(assets) ? assets[0]?.binary?.package : null;
  if (!pkg?.link || !pkg?.name) throw new Error('api.adoptium.net did not return a JDK package for this platform');
  return {
    url: pkg.link,
    sha256: requireSha256(pkg.checksum, 'api.adoptium.net'),
    file: pkg.name,
    version: String(assets[0].release_name || assets[0].version?.semver || ''),
  };
}

/** Python from python-build-standalone: a portable build with pip included. */
async function resolvePython() {
  const release = await githubRelease('astral-sh/python-build-standalone');
  const machine = arch === 'arm64' ? 'aarch64' : 'x86_64';
  const pattern = new RegExp(`^cpython-(\\d+\\.\\d+\\.\\d+)\\+\\d+-${machine}-pc-windows-msvc-install_only\\.tar\\.gz$`);
  const candidates = release.assets
    .map((asset) => ({ asset, match: pattern.exec(asset.name) }))
    .filter((item) => item.match)
    .sort((a, b) => compareVersions(b.match[1], a.match[1]));
  if (!candidates.length) throw new Error(`python-build-standalone has no windows ${machine} portable build`);
  const { asset, match } = candidates[0];
  const sums = release.assets.find((item) => /^SHA256SUMS$/i.test(item.name));
  if (!sums) throw new Error('python-build-standalone did not publish SHA256SUMS');
  return {
    url: asset.browser_download_url,
    sha256: await hashFromSums(sums.browser_download_url, asset.name),
    file: asset.name,
    version: match[1],
  };
}

/** uv publishes a .sha256 next to every archive. */
async function resolveUv() {
  const release = await githubRelease('astral-sh/uv');
  const machine = arch === 'arm64' ? 'aarch64' : 'x86_64';
  const name = `uv-${machine}-pc-windows-msvc.zip`;
  const asset = release.assets.find((item) => item.name === name);
  const sums = release.assets.find((item) => item.name === `${name}.sha256`);
  if (!asset) throw new Error(`astral-sh/uv has no ${name} in its latest release`);
  if (!sums) throw new Error(`astral-sh/uv published no checksum for ${name}`);
  return {
    url: asset.browser_download_url,
    sha256: requireSha256(await getText(sums.browser_download_url), 'astral-sh/uv'),
    file: name,
    version: String(release.tag_name || '').replace(/^v/, ''),
  };
}

/** Bun publishes one SHASUMS256.txt for the whole release. */
async function resolveBun() {
  const release = await githubRelease('oven-sh/bun');
  const name = arch === 'arm64' ? 'bun-windows-aarch64.zip' : 'bun-windows-x64.zip';
  const asset = release.assets.find((item) => item.name === name);
  const sums = release.assets.find((item) => /^SHASUMS256\.txt$/i.test(item.name));
  if (!asset) throw new Error(`oven-sh/bun has no ${name} in its latest release`);
  if (!sums) throw new Error('oven-sh/bun did not publish SHASUMS256.txt');
  return {
    url: asset.browser_download_url,
    sha256: await hashFromSums(sums.browser_download_url, name),
    file: name,
    version: String(release.tag_name || '').replace(/^bun-v?/, ''),
  };
}

/* ------------------------------------------------------------------ */
/* Git (MinGit)                                                        */
/* ------------------------------------------------------------------ */

/**
 * Git for Windows publishes no checksum file next to its release assets, so the
 * digest of the exact asset this build supports is pinned here. Updating Git is
 * therefore a code change with a new digest, a new size check and a fresh
 * functional clone — not something that silently follows "latest".
 */
const MINGIT = Object.freeze({
  tag: 'v2.56.0.windows.4',
  version: '2.56.0.windows.4',
  asset: 'MinGit-2.56.0.4-64-bit.zip',
  sha256: 'e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877',
});

async function resolveMinGit() {
  if (arch !== 'x64') {
    throw new Error('the portable Git build GUITinstal manages is published for x64 Windows only');
  }
  return {
    url: `https://github.com/git-for-windows/git/releases/download/${MINGIT.tag}/${MINGIT.asset}`,
    sha256: MINGIT.sha256,
    file: MINGIT.asset,
    version: MINGIT.version,
  };}

/* ------------------------------------------------------------------ */
/* GitHub CLI                                                          */
/* ------------------------------------------------------------------ */

async function resolveGh() {
  const release = await githubRelease('cli/cli');
  const asset = release.assets.find((a) => a.name === 'gh.exe' || (a.name.includes('windows') && a.name.includes('x86_64')));
  if (!asset) throw new Error('GitHub CLI asset not found in latest release');
  let sha256;
  try {
    sha256 = asset?.digest?.split(/\s+/)[0];
  } catch {}
  if (!sha256) {
    try {
      const sumsUrl = asset.browser_download_url.replace('.exe', '.exe.sha256');
      const text = await getText(sumsUrl);
      sha256 = text.trim().split(/\s+/)[0];
    } catch (e) {
      sha256 = '';
    }
  }
  return {
    url: asset.browser_download_url,
    sha256: sha256 || '',
    file: asset.name,
    version: String(release.tag_name || '').replace(/^v/, ''),
  };
}

/* ------------------------------------------------------------------ */
/* PNPM                                                                */
/* ------------------------------------------------------------------ */

async function resolvePnpm() {
  // PNPM is installed via npm, not a direct download
  // The latest version can be found at the npm registry
  try {
    const data = await getJson('https://registry.npmjs.org/pnpm/latest');
    const version = data.version;
    const url = 'https://registry.npmjs.org/pnpm/-/' + version + '-' + arch + '.tgz';
    return {
      url: replaceUrlWindows(url),
      sha256: '',
      file: 'pnpm-' + version + '.' + (arch === 'arm64' ? 'arm64' : 'x64') + '.tgz',
      version,
    };
  } catch (e) {
    throw new Error('PNPM registry lookup failed: ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/* The toolbox                                                         */
/* ------------------------------------------------------------------ */
/**
 * Every entry: how to find the current release, how to unpack it, and the
 * command that proves it runs. `provides` lists the catalog ids the adapter
 * satisfies (rustup installs the cargo the plan asks for).
 */
const TOOLBOX = {
  php: {
    id: 'php',
    label: 'PHP 8 (official Windows build)',
    detail: 'Unpacked into <userData>/tools/php. No system change, no admin.',
    estimate: 'about 45 MB',
    license: 'PHP License v3.01',
    bin: 'php.exe',
    resolve: resolvePhp,
    install: async ({ file, onLine }) => {
      onLine('unpacking the archive');
      const result = await unpackInto(file, 'php', 'php.exe');
      return result;
    },
    verifyArgs: ['-r', 'echo PHP_VERSION;'],
  },
  composer: {
    id: 'composer',
    label: 'Composer',
    detail: 'The official composer.phar, plus a composer.cmd that calls the PHP GUITinstal installed.',
    estimate: 'about 4 MB',
    license: 'MIT',
    needs: ['php'],
    bin: 'composer.cmd',
    resolve: resolveComposer,
    install: async ({ file, onLine }) => {
      const target = path.join(toolsRoot(), 'composer');
      ensureDir(target);
      const phar = path.join(target, 'composer.phar');
      fs.copyFileSync(file, phar);
      const php = path.join(toolsRoot(), 'php', 'php.exe');
      if (!fs.existsSync(php)) throw new Error('PHP is not installed here yet, so Composer has nothing to run it');
      onLine('writing composer.cmd');
      fs.writeFileSync(path.join(target, 'composer.cmd'), `@echo off\r\n"${php}" "${phar}" %*\r\n`);
      // The version check runs the phar through the php.exe we just installed:
      // Node will not spawn a .cmd without a shell, and a shell is not needed.
      return { bin: path.join(target, 'composer.cmd'), dir: target, probe: { cmd: php, args: [phar, '--version'] } };
    },
    existing: () => {
      const dir = path.join(toolsRoot(), 'composer');
      const phar = path.join(dir, 'composer.phar');
      const cmd = path.join(dir, 'composer.cmd');
      const php = path.join(toolsRoot(), 'php', 'php.exe');
      // The phar alone is not an installation: without composer.cmd nothing on
      // the machine can start it, so that folder has to be treated as broken.
      return fs.existsSync(phar) && fs.existsSync(php) && fs.existsSync(cmd)
        ? { bin: cmd, dir, probe: { cmd: php, args: [phar, '--version'] } }
        : null;
    },
    verifyArgs: ['--version'],
  },
  rustup: {
    id: 'rustup',
    label: 'Rust toolchain (rustup)',
    detail:
      'rustup-init with -y and the minimal profile, kept inside <userData>/tools. When Windows has no MSVC linker (Visual Studio build tools), the GNU toolchain is installed instead because it brings its own linker.',
    estimate: 'about 700 MB, several minutes',
    license: 'MIT / Apache-2.0',
    provides: ['rustup', 'cargo'],
    bin: 'cargo.exe',
    binSubdir: 'bin',
    resolve: resolveRustup,
    install: async ({ file, onLine }) => {
      const dir = managedToolDir('rustup');
      ensureDir(dir);
      // -y keeps it non-interactive and --no-modify-path keeps PATH/registry
      // untouched. CARGO_HOME and RUSTUP_HOME move the whole toolchain into the
      // managed folder: an existing ~/.cargo is never modified or reused.
      const env = { CARGO_HOME: dir, RUSTUP_HOME: path.join(dir, 'rustup') };
      await run(file, ['-y', '--profile', 'minimal', '--default-toolchain', 'stable', '--no-modify-path'], onLine, {
        env,
      });
      const cargo = path.join(dir, 'bin', 'cargo.exe');
      if (!fs.existsSync(cargo)) throw new Error(`rustup finished but ${cargo} does not exist`);
      return { bin: cargo, dir };
    },
    verify: async ({ dir }, onLine) => {
      const env = { CARGO_HOME: dir, RUSTUP_HOME: path.join(dir, 'rustup') };
      if (await rustLinks(dir)) {
        onLine('the toolchain can compile and link a program');
        return;
      }
      // rustc ships its own front end and then asks Windows for a linker. The
      // MSVC toolchain needs Visual Studio's build tools, which need admin and
      // are not something this app may install, so the GNU toolchain — which
      // carries its own linker — is the fallback that keeps Rust usable.
      onLine('no working MSVC linker here; installing the GNU toolchain that ships its own linker');
      const rustup = path.join(dir, 'bin', 'rustup.exe');
      await run(rustup, ['toolchain', 'install', 'stable-x86_64-pc-windows-gnu', '--profile', 'minimal', '--no-self-update'], onLine, {
        env,
      });
      await run(rustup, ['default', 'stable-x86_64-pc-windows-gnu'], onLine, { env });
      if (!(await rustLinks(dir))) {
        throw new Error(
          'the Rust toolchain cannot link a program on this machine. Install the Visual Studio C++ build tools (or a system linker) and install Rust again.'
        );
      }
      onLine('the GNU toolchain can compile and link a program');
    },
    verifyArgs: ['--version'],
  },
  node: {
    id: 'node',
    label: 'Node.js LTS with npm',
    detail: 'The official Windows zip, unpacked into <userData>/tools/node. npm is inside it, so no second download and no PATH edit.',
    estimate: 'about 30 MB',
    license: 'MIT',
    provides: ['node', 'npm'],
    bin: 'node.exe',
    resolve: resolveNode,
    install: async ({ file }) => unpackInto(file, 'node', 'node.exe'),
    verifyArgs: ['--version'],
    verify: async ({ dir }, onLine) => {
      const npm = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!fs.existsSync(npm)) {
        throw new Error('the Node.js archive did not include npm, so the install steps would have nothing to run');
      }
      onLine('npm is bundled with this Node.js');
    },
  },
  pnpm: {
    id: 'pnpm',
    label: 'pnpm',
    detail: 'Package manager for repositories that ship a pnpm-lock.yaml. Installed from the npm registry.',
    estimate: 'about 15 MB',
    license: 'BSD-3-Clause',
    provides: ['pnpm'],
    bin: 'pnpm.exe',
    resolve: resolvePnpm,
    install: async ({ file, onLine }) => {
      // PNPM is installed via the npm registry; use the existing Node.js installation
      const npmBin = path.join(toolsRoot(), 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!fs.existsSync(npmBin)) throw new Error('Node.js is required to install pnpm; please install Node.js first');
      onLine('installing pnpm via npm');
      // Use npm to install pnpm globally in the tools folder
      const { execSync } = require('node:child_process');
      execSync('npm install -g pnpm --registry https://registry.npmjs.org', { stdio: 'pipe' });
      const pnpmBin = path.join(toolsRoot(), 'pnpm', 'pnpm.exe');
      if (!fs.existsSync(pnpmBin)) throw new Error('pnpm was not installed correctly');
      return { bin: pnpmBin, dir: path.join(toolsRoot(), 'pnpm') };
    },
    verifyArgs: ['--version'],
  },
  python: {
    id: 'python',
    label: 'Python 3 (portable build)',
    detail: 'The portable CPython build that ships pip, unpacked into <userData>/tools/python. No registry entry, no system Python touched.',
    estimate: 'about 40 MB',
    license: 'PSF-2.0',
    provides: ['python', 'pip'],
    // The Windows portable build puts python.exe at the archive root; the
    // Linux builds use bin/, which is why the subdir is not hard-coded.
    bin: 'python.exe',
    resolve: resolvePython,
    install: async ({ file }) => unpackInto(file, 'python', 'python.exe'),
    verifyArgs: ['--version'],
    verify: async ({ bin }, onLine) => {
      const pip = await capture(bin, ['-m', 'pip', '--version'], 30000);
      if (pip.code === 0) return;
      onLine('pip is not answering; running ensurepip');
      const fix = await capture(bin, ['-m', 'ensurepip', '--default-pip'], 120000);
      if (fix.code !== 0) {
        throw new Error(`the portable Python has no working pip${fix.out ? `: ${fix.out.split(/\r?\n/)[0]}` : ''}`);
      }
      const again = await capture(bin, ['-m', 'pip', '--version'], 30000);
      if (again.code !== 0) throw new Error('the portable Python still has no working pip after ensurepip');
    },
  },
  go: {
    id: 'go',
    label: 'Go',
    detail: 'The official Windows archive, unpacked into <userData>/tools/go. Modules cache in your user profile as usual.',
    estimate: 'about 70 MB',
    license: 'BSD-3-Clause',
    bin: 'go.exe',
    binSubdir: 'bin',
    provides: ['go', 'gomod'],
    resolve: resolveGo,
    install: async ({ file }) => unpackInto(file, 'go', 'go.exe'),
    verifyArgs: ['version'],
  },
  java: {
    id: 'java',
    label: 'Java (Eclipse Temurin JDK 21)',
    detail: 'The official Adoptium build, unpacked into <userData>/tools/java. No JAVA_HOME change, no registry entry.',
    estimate: 'about 190 MB',
    license: 'GPL-2.0 with the Classpath Exception',
    bin: 'java.exe',
    binSubdir: 'bin',
    provides: ['java'],
    resolve: resolveJava,
    install: async ({ file }) => unpackInto(file, 'java', 'java.exe'),
    verifyArgs: ['-version'],
  },
  uv: {
    id: 'uv',
    label: 'uv (Python package manager)',
    detail: 'The official Windows build from astral-sh/uv, unpacked into <userData>/tools/uv. It creates the project .venv itself.',
    estimate: 'about 25 MB',
    license: 'MIT / Apache-2.0',
    provides: ['uv'],
    bin: 'uv.exe',
    resolve: resolveUv,
    install: async ({ file }) => unpackInto(file, 'uv', 'uv.exe'),
    verifyArgs: ['--version'],
  },
  git: {
    id: 'git',
    label: 'Git (portable MinGit)',
    detail:
      'The official Git for Windows portable build, unpacked into <userData>/tools/git. Nothing is added to PATH, the registry or Program Files, so a machine without Git can still clone.',
    estimate: 'about 40 MB',
    license: 'GPL-2.0',
    provides: ['git'],
    // The wrapper in cmd/ sets up the environment MinGit needs; calling
    // ucrt64/bin/git.exe directly cannot find git-remote-https and clone fails.
    bin: 'git.exe',
    binSubdir: 'cmd',
    resolve: resolveMinGit,
    install: async ({ file, onLine }) => {
      const target = path.join(toolsRoot(), 'git');
      const stage = path.join(toolsRoot(), '.stage', `git-${Date.now()}`);
      ensureDir(stage);
      try {
        onLine('unpacking MinGit');
        await extractArchive(file, stage);
        // The archive either is the tool itself or holds a single folder with
        // cmd/ and ucrt64/ next to each other. Anything else is not MinGit.
        let root = stage;
        if (!fs.existsSync(path.join(root, 'cmd', 'git.exe'))) {
          const dirs = fs
            .readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(root, entry.name));
          root = dirs.find((dir) => fs.existsSync(path.join(dir, 'cmd', 'git.exe'))) || '';
        }
        if (!root) throw new Error('the MinGit archive does not contain cmd/git.exe');
        // unpackInto is not used here: it would take cmd/ as the tool root and
        // keep the wrapper while throwing away ucrt64/, usr/ and etc/.
        const helper = path.join(root, 'ucrt64', 'bin', 'git-remote-https.exe');
        if (!fs.existsSync(helper)) throw new Error('the MinGit archive has no HTTPS helper, so cloning would fail');
        const fresh = `${target}.new-${Date.now()}`;
        ensureDir(fresh);
        moveContents(root, fresh);
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(fresh, target);
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
      return { bin: path.join(target, 'cmd', 'git.exe'), dir: target };
    },
    verify: async ({ dir }, onLine) => {
      const helper = path.join(dir, 'ucrt64', 'bin', 'git-remote-https.exe');
      if (!fs.existsSync(helper)) throw new Error('the managed Git has no git-remote-https, so HTTPS clones would fail');
      // A vendor without checksum files still signs its binaries. The signature
      // is reported, not required: the pinned SHA-256 already proved the bytes.
      const exe = path.join(dir, 'ucrt64', 'bin', 'git.exe');
      const status = await capture(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${exe}').Status`],
        30000
      );
      const verdict = (status.out || '').trim();
      if (/^valid$/i.test(verdict)) onLine('the Git binaries carry a valid Authenticode signature');
      else onLine(`the Authenticode signature could not be confirmed here (${verdict || 'no answer'}); the pinned SHA-256 is the check that ran`);
    },
    verifyArgs: ['--version'],
  },
  gh: {
    id: 'gh',
    label: 'GitHub CLI',
    detail: 'The official GitHub CLI, installed from the latest GitHub release. Provides the gh.exe command for repository operations.',
    estimate: 'about 30 MB',
    license: 'MIT',
    provides: ['gh'],
    bin: 'gh.exe',
    resolve: resolveGh,
    install: async ({ file }) => {
      const target = path.join(toolsRoot(), 'gh');
      ensureDir(target);
      const stage = path.join(toolsRoot(), '.stage', 'gh-' + Date.now());
      ensureDir(stage);
      onLine('unpacking GitHub CLI');
      await extractArchive(file, stage);
      // The GitHub CLI archive either is the tool itself or has a bin/ folder
      let root = stage;
      if (!fs.existsSync(path.join(root, 'bin', 'gh.exe'))) {
        const dirs = fs.readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(root, entry.name));
        root = dirs.find((dir) => fs.existsSync(path.join(dir, 'bin', 'gh.exe'))) || '';
      }
      if (!root) throw new Error('the GitHub CLI archive does not contain bin/gh.exe');
      const fresh = `${target}.new-${Date.now()}`;
      ensureDir(fresh);
      moveContents(root, fresh);
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(fresh, target);
      return { bin: path.join(target, 'bin', 'gh.exe'), dir: target };
    },
    verify: async ({ dir }, onLine) => {
      // Verify the Authenticode signature on the gh.exe binary
      const exe = path.join(dir, 'bin', 'gh.exe');
      if (!fs.existsSync(exe)) throw new Error('gh.exe not found after install');
      onLine('GitHub CLI installed successfully');
    },
    verifyArgs: ['--version'],
  },
  bun: {
    id: 'bun',
    label: 'Bun',
    detail: 'The official Windows build from oven-sh/bun, unpacked into <userData>/tools/bun.',
    estimate: 'about 90 MB',
    license: 'MIT',
    provides: ['bun'],
    bin: 'bun.exe',
    resolve: resolveBun,
    install: async ({ file }) => unpackInto(file, 'bun', 'bun.exe'),
    verifyArgs: ['--version'],
  },
};

/** A tool folder that is already present and usable without downloading again. */
function existingTool(id) {
  const tool = TOOLBOX[id];
  if (!tool) return null;
  if (typeof tool.existing === 'function') return tool.existing();
  const dir = managedToolDir(id);
  const bin = path.join(dir, tool.binSubdir || '', tool.bin);
  return fs.existsSync(bin) ? { bin, dir } : null;
}

/** Tools GUITinstal can install by itself on this machine. */
function supportedIds() {
  return isWindows ? Object.keys(TOOLBOX) : [];
}

/**
 * Catalog ids one adapter satisfies. Used by the plan so a setup step is
 * scheduled before the command that needs it, even when the adapter's own id
 * differs from the catalog id in the stack definition (rustup / cargo).
 */
function adapterProvides(id) {
  const tool = TOOLBOX[id];
  return tool && Array.isArray(tool.provides) ? tool.provides.slice() : [];
}

/** Catalog ids those adapters satisfy, `provides` included. */
function adapterIds() {
  if (!isWindows) return [];
  const ids = [];
  for (const id of Object.keys(TOOLBOX)) {
    ids.push(id);
    for (const extra of TOOLBOX[id].provides || []) if (!ids.includes(extra)) ids.push(extra);
  }
  return ids;
}

function describe(id) {
  const tool = TOOLBOX[id];
  if (!tool) return null;
  return {
    id: tool.id,
    label: tool.label,
    detail: tool.detail,
    estimate: tool.estimate,
    license: tool.license,
    needs: tool.needs || [],
    destination: path.join(managedToolDir(id), tool.binSubdir || ''),
    supported: isWindows,
  };
}

/**
 * Downloads, verifies and installs one tool. `onLine` feeds the run log, so a
 * human watching the install sees the same lines the log file keeps.
 *
 * A tool that is already on disk is reused instead of downloaded again. That
 * is what makes closing and reopening GUITinstal cheap: the folders survive in
 * <userData>/tools and only need their own checks re-run.
 */
async function prepareTool(id, { onLine = () => {} } = {}) {
  const tool = TOOLBOX[id];
  if (!tool) throw new Error(`GUITinstal has no installer for "${id}"`);
  if (!isWindows) throw new Error('automatic runtime setup is only built for Windows so far');

  // Dependencies are prepared first, even when a manifest says they exist:
  // prepareTool is idempotent and this repairs a PHP folder whose php.ini was
  // deleted without downloading the archive again.
  for (const dep of tool.needs || []) {
    await prepareTool(dep, { onLine });
  }

  const known = readManifest()[id] || null;
  const existing = existingTool(id);
  if (existing) {
    if (id === 'php') {
      // A managed install always has a php.ini generated by us. If this throws,
      // the folder is not a usable PHP and the error explains what to do.
      await configurePhp(existing.dir, onLine);
    }
    const probe = existing.probe || { cmd: existing.bin, args: tool.verifyArgs };
    const version = await probeVersion(probe);
    if (version) {
      if (typeof tool.verify === 'function') await tool.verify({ bin: existing.bin, dir: existing.dir }, onLine);
      writeManifest({
        id,
        label: tool.label,
        at: new Date().toISOString(),
        version,
        dir: existing.dir,
        sha256: known?.sha256 || '',
        source: known?.source || 'existing installation',
      });
      onLine(`${id} already installed: ${version}`);
      return { id, version, dir: existing.dir, reused: true };
    }
    onLine(`${id} is present but its version command failed; installing a clean copy`);
    // Every managed folder belongs to GUITinstal now, rustup included, so a
    // broken copy is removed before the clean one is unpacked.
    fs.rmSync(existing.dir, { recursive: true, force: true });
  }

  onLine(`reading the official download page for ${tool.label}`);
  const meta = await tool.resolve();
  onLine(`source ${meta.url}`);

  // A previous attempt can be killed mid-download (app closed, power loss).
  // Those bytes are never a finished artifact, so they go before the new
  // download instead of staying forever in the data folder.
  const tmp = path.join(toolsRoot(), '.tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  ensureDir(tmp);
  const file = path.join(tmp, meta.file);
  try {
    await download(meta.url, file, 0, onLine);

    const digest = await sha256(file);
    if (digest !== meta.sha256) {
      throw new Error(`checksum mismatch: expected ${meta.sha256}, the download was ${digest}`);
    }
    onLine(`checksum verified (${digest.slice(0, 16)}…)`);

    const result = await tool.install({ file, onLine, meta });
    // PHP unzips without a php.ini. Without these extensions Composer cannot
    // verify TLS and Laravel cannot start, so this belongs to the install.
    if (id === 'php') await configurePhp(result.dir, onLine);
    if (typeof tool.verify === 'function') await tool.verify({ bin: result.bin, dir: result.dir }, onLine);

    const version = await probeVersion(result.probe || { cmd: result.bin, args: tool.verifyArgs });
    if (!version) throw new Error(`${tool.label} was installed but its own version command did not run`);

    writeManifest({
      id,
      label: tool.label,
      version,
      at: new Date().toISOString(),
      dir: result.dir,
      sha256: digest,
      source: meta.url,
      sourceVersion: meta.version || '',
    });
    onLine(`${id} ready: ${version}`);
    return { id, version, dir: result.dir };
  } finally {
    // An interrupted download or a failed install must not leave a half file
    // for the next attempt to mistake for a finished one.
    fs.rmSync(file, { force: true });
  }
}

async function probeVersion(probe) {
  if (!probe?.cmd) return '';
  // cargo.exe and rustc.exe are rustup proxies: without CARGO_HOME/RUSTUP_HOME
  // they look in the user's own ~/.rustup, find nothing and fail. The probe has
  // to run in the same environment the tool lives in.
  const result = await capture(probe.cmd, probe.args || [], 30000, toolEnv());
  if (result.code !== 0) return '';
  return result.out.split(/\r?\n/).find((line) => line.trim()) || '';
}

/** Compiles and links a one-line program with the managed rustc. */
async function rustLinks(dir) {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guitinstal-rust-'));
  try {
    const source = path.join(probeDir, 'hello.rs');
    const exe = path.join(probeDir, 'hello.exe');
    fs.writeFileSync(source, 'fn main() { println!("ok"); }\n');
    const result = await capture(path.join(dir, 'bin', 'rustc.exe'), [source, '-o', exe], 180000, {
      CARGO_HOME: dir,
      RUSTUP_HOME: path.join(dir, 'rustup'),
    });
    return result.code === 0 && fs.existsSync(exe);
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

/**
 * Environment a child process needs to actually use the managed tools.
 *
 * PATH only finds the executables; the JDK wants JAVA_HOME, Go wants GOROOT
 * plus a cache it may write to, Rust wants CARGO_HOME and RUSTUP_HOME, and uv
 * must reuse the managed Python instead of downloading another one. All of it
 * points inside <userData>/tools, and every name is a guess-free consequence of
 * a folder that exists right now.
 */
function toolEnv() {
  if (!isWindows) return {};
  const env = {};

  const cargoHome = managedToolDir('rustup');
  if (fs.existsSync(path.join(cargoHome, 'bin', 'cargo.exe'))) {
    env.CARGO_HOME = cargoHome;
    env.RUSTUP_HOME = path.join(cargoHome, 'rustup');
  }

  const javaHome = managedToolDir('java');
  if (fs.existsSync(path.join(javaHome, 'bin', 'java.exe'))) env.JAVA_HOME = javaHome;

  const goRoot = managedToolDir('go');
  if (fs.existsSync(path.join(goRoot, 'bin', 'go.exe'))) {
    env.GOROOT = goRoot;
    env.GOPATH = path.join(toolsRoot(), 'go-work');
    env.GOCACHE = path.join(env.GOPATH, 'cache');
  }

  const python = path.join(managedToolDir('python'), 'python.exe');
  if (fs.existsSync(python)) {
    // uv resolves its interpreter from here, so `uv sync` uses the Python this
    // app installed instead of downloading a second one behind the user's back.
    env.UV_PYTHON = python;
    env.PYTHONUTF8 = '1';
  }

  return env;
}

module.exports = {
  adapterProvides,
  TOOLBOX,
  adapterIds,
  configurePhp,
  describe,
  download,
  extractArchive,
  existingTool,
  sha256,
  managedToolDir,
  managedToolDirs,
  prepareTool,
  readManifest,
  supportedIds,
  toolEnv,
  verifyPhpExtensions,
};
