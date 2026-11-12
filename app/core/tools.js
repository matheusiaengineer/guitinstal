'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');

const { managedToolDir, managedToolDirs } = require('./runtime-install');

const cache = new Map();
let statusCache = null;
let pathDirsCache = null;

/** Expands %SYSTEMROOT%-style names that Windows stores inside registry PATH. */
function expandEnv(value) {
  return String(value).replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all);
}

/**
 * PATH entries that this process cannot see. An installer writes its changes to
 * the registry, but a process that is already running keeps the environment
 * block it was started with, so a runtime installed after GUITinstal opened
 * stays invisible until the registry is read here.
 */
function registryPathDirs() {
  if (process.platform !== 'win32') return [];
  const keys = [
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    'HKCU\\Environment',
  ];
  const dirs = [];
  for (const key of keys) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', key, '/v', 'Path'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
      });
    } catch {
      continue; // no such value, or reg itself is unavailable
    }
    const line = text.split(/\r?\n/).find((item) => /REG_(?:EXPAND_)?SZ/i.test(item));
    if (!line) continue;
    const value = line.replace(/^.*?REG_(?:EXPAND_)?SZ\s+/i, '').trim();
    for (const entry of expandEnv(value).split(';')) {
      if (entry.trim()) dirs.push(entry.trim());
    }
  }
  return dirs;
}

/** Every directory a tool may live in, this process's PATH first. */
function pathDirs() {
  if (pathDirsCache) return pathDirsCache;
  const dirs = [];
  const seen = new Set();
  // Tools GUITinstal installed itself come first: they are the ones the user
  // asked for, and a stale system-wide copy must not shadow them.
  for (const dir of [...managedToolDirs(), ...(process.env.PATH || '').split(path.delimiter), ...registryPathDirs()]) {
    const key = dir.toLowerCase().replace(/[\\/]+$/, '');
    if (!dir || seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  pathDirsCache = dirs;
  return dirs;
}

/** PATH string for child processes, including the registry-only directories. */
function effectivePath() {
  return pathDirs().join(path.delimiter);
}

/** Locates an executable by scanning PATH (no shell, no globbing). */
function findOnPath(command) {
  const isWindows = process.platform === 'win32';
  const exts = isWindows
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const dirs = pathDirs();

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, isWindows ? `${command}${ext.toLowerCase()}` : command);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

/**
 * Forgets every lookup so a re-check can find a runtime the user installed
 * while GUITinstal was open. Without this, a tool once judged missing stays
 * missing for the life of the process.
 */
function forgetToolLookups() {
  cache.clear();
  statusCache = null;
  pathDirsCache = null;
}

/** Is this path an actual node binary (not Electron, not a .cmd shim)? */
function isNodeExecutable(candidate) {
  if (!candidate) return false;
  if (!/(^|[\\/])node(\.exe)?$/i.test(candidate)) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves a tool to an executable description.
 * Every entry runs WITHOUT a shell, so nothing the app passes can be
 * interpreted as shell syntax.
 */
function resolveTool(name) {
  if (cache.has(name)) return cache.get(name);

  let tool = null;

  if (name === 'npm') {
    // npm ships as npm.cmd on Windows. Node blocks spawning .cmd without a
    // shell, and running it through a shell would open an injection seam.
    // Executing npm's own entry point with node keeps shell:false intact.
    //
    // In the installed app process.execPath is GUITinstal.exe, so the npm tree
    // has to be looked for next to the real node and next to the npm shim.
    const shim = findOnPath('npm');
    const nodeExe = [process.execPath, findOnPath('node')].find(isNodeExecutable) || '';
    const npmCli = [
      process.env.npm_execpath,
      nodeExe && path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      shim && path.join(path.dirname(shim), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]
      .filter(Boolean)
      .find(isFile);
    if (npmCli && nodeExe) {
      tool = { cmd: nodeExe, args: [npmCli], display: 'npm', shell: false };
    } else {
      tool = { cmd: 'npm', args: [], display: 'npm', shell: false, missing: true };
    }
  } else if (name === 'composer') {
    // Composer installed by GUITinstal is a phar, and a phar is not an
    // executable: it runs through the php.exe that came with it. Same trick as
    // npm above, so the step keeps shell:false.
    const php = findOnPath('php');
    const phar = path.join(managedToolDir('composer'), 'composer.phar');
    if (php && isFile(phar)) {
      tool = { cmd: php, args: [phar], display: 'composer', shell: false };
    } else {
      const cmd = findOnPath(name);
      tool = cmd
        ? { cmd, args: [], display: name, shell: false }
        : { cmd: name, args: [], display: name, shell: false, missing: true };
    }
  } else {
    const cmd = findOnPath(name);
    tool = cmd
      ? { cmd, args: [], display: name, shell: false }
      : { cmd: name, args: [], display: name, shell: false, missing: true };
  }

  cache.set(name, tool);
  return tool;
}

function isWindows() {
  return process.platform === 'win32';
}

/** Command used to run a python module inside a virtual environment. */
function venvPython(venvDir) {
  return isWindows()
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

/** Runs a tool and captures its first line of output (used for version checks). */
function probe(tool, args = ['--version']) {
  return new Promise((resolve) => {
    if (tool.missing) {
      resolve({ available: false, version: '' });
      return;
    }
    try {
      execFile(
        tool.cmd,
        [...tool.args, ...args],
        { shell: tool.shell === true, windowsHide: true, timeout: 12000 },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ available: false, version: '' });
            return;
          }
          const text = `${stdout || stderr || ''}`.trim().split('\n')[0] || '';
          resolve({ available: true, version: text });
        }
      );
    } catch {
      resolve({ available: false, version: '' });
    }
  });
}

const RUNTIMES = [
  { id: 'node', label: 'Node.js', tool: 'node', args: ['--version'], install: 'https://nodejs.org/en/download' },
  { id: 'npm', label: 'npm', tool: 'npm', args: ['--version'], install: 'https://nodejs.org/en/download', note: 'npm comes with the Node.js installer.' },
  { id: 'python', label: 'Python', tool: 'python', args: ['--version'], install: 'https://www.python.org/downloads/' },
  { id: 'docker', label: 'Docker', tool: 'docker', args: ['--version'], install: 'https://docs.docker.com/get-docker/' },
  { id: 'git', label: 'Git', tool: 'git', args: ['--version'], install: 'https://git-scm.com/downloads', note: 'GUITinstal installs a portable Git when this machine has none.' },
  { id: 'go', label: 'Go', tool: 'go', args: ['version'], install: 'https://go.dev/dl/' },
  { id: 'cargo', label: 'Rust (Cargo)', tool: 'cargo', args: ['--version'], install: 'https://www.rust-lang.org/tools/install' },
  { id: 'dotnet', label: '.NET SDK', tool: 'dotnet', args: ['--version'], install: 'https://dotnet.microsoft.com/en-us/download' },
  { id: 'xcode', label: 'Xcode', tool: 'xcodebuild', args: ['-version'], install: 'https://developer.apple.com/xcode/', note: 'Xcode runs only on macOS and is installed through Apple.' },
  { id: 'java', label: 'Java', tool: 'java', args: ['-version'], install: 'https://adoptium.net/temurin/releases/' },
  { id: 'php', label: 'PHP', tool: 'php', args: ['--version'], install: 'https://www.php.net/downloads.php', note: 'PHP is the runtime Composer and the project need.' },
  { id: 'composer', label: 'PHP (Composer)', tool: 'composer', args: ['--version'], install: 'https://getcomposer.org/download/', note: 'Composer also needs PHP on the machine.' },
  { id: 'uv', label: 'uv', tool: 'uv', args: ['--version'], install: 'https://docs.astral.sh/uv/getting-started/installation/', note: 'uv installs the exact versions in uv.lock.' },
  { id: 'bun', label: 'Bun', tool: 'bun', args: ['--version'], install: 'https://bun.sh/docs/installation', note: 'Bun replaces node and npm for projects that ship bun.lockb.' },
  { id: 'bundle', label: 'Ruby (Bundler)', tool: 'bundle', args: ['--version'], install: 'https://www.ruby-lang.org/en/downloads/', note: 'Install Ruby and Bundler for your operating system.' },
  { id: 'make', label: 'Make', tool: 'make', args: ['--version'], install: 'https://www.gnu.org/software/make/' },
];

/** Where a runtime comes from, so a missing tool is an instruction and not a dead end. */
const INSTALL_HINTS = new Map(RUNTIMES.map((runtime) => [runtime.id, runtime]));

/** @returns {{ url: string, note: string }} official download page for a runtime id */
function installHint(id) {
  const runtime = INSTALL_HINTS.get(id);
  return { url: (runtime && runtime.install) || '', note: (runtime && runtime.note) || '' };
}

/**
 * Which runtime a command line belongs to. Plans write absolute paths into the
 * command (the venv python, npm's own node), so the file name is the only
 * reliable way back to the runtime the user has to install.
 */
function runtimeFor(command) {
  const base = String(command || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.(exe|cmd|bat|sh)$/i, '')
    .toLowerCase();
  if (!base) return null;
  const hit = RUNTIMES.find((runtime) => runtime.id === base || runtime.tool.toLowerCase() === base);
  return hit ? { id: hit.id, label: hit.label, url: hit.install, note: hit.note || '' } : null;
}

/** Which runtimes are installed on this machine, with their versions. */
async function runtimeStatus(options = {}) {
  // Plans are built on every analysis, so the probes (12 child processes)
  // must not run again for each repository in the same session.
  if (options.refresh) forgetToolLookups();
  else if (statusCache && statusCache.expires > Date.now()) return statusCache.value;

  const results = await Promise.all(
    RUNTIMES.map(async (runtime) => {
      const tool = resolveTool(runtime.tool);
      const result = await probe(tool, runtime.args);
      return {
        id: runtime.id,
        label: runtime.label,
        available: result.available,
        version: result.version,
        install: runtime.install,
        note: runtime.note || '',
      };
    })
  );

  statusCache = { value: results, expires: Date.now() + 60 * 1000 };
  return results;
}

/** Detects the python interpreter that should create the virtual environment. */
function pythonExecutable() {
  const direct = findOnPath('python');
  if (direct) return direct;
  const launcher = findOnPath('py');
  if (launcher) return launcher;
  return null;
}

module.exports = {
  effectivePath,
  findOnPath,
  forgetToolLookups,
  installHint,
  isWindows,
  probe,
  pythonExecutable,
  registryPathDirs,
  resolveTool,
  runtimeFor,
  runtimeStatus,
  venvPython,
};
