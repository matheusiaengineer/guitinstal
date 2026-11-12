'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const {
  addFavorite,
  getProject,
  getSettings,
  growthByRepo,
  libraryStatus,
  listFavorites,
  listProjects,
  publicSettings,
  recordRepoStats,
  removeFavorite,
  removeProject,
  tokenStatus,
  updateSettings,
  upsertProject,
} = require('../core/store');
const { defaultWorkspace, userDataDir } = require('../core/paths');
const changelog = require('../core/changelog');
const { answerWithAI, suggestFileRepair } = require('../core/ai');
const localAi = require('../core/local-ai');
const {
  listAiProviders,
  removeAiProvider,
  reorderAiProviders,
  saveAiProvider,
} = require('../core/ai-providers');
const { applyProjectFile, readProjectFile } = require('../core/file-repair');
const { projectGuide } = require('../core/project-guide');
const {
  browseRepos,
  fetchCommits,
  fetchFile,
  fetchRepo,
  fetchTree,
  fetchUserRepos,
  fetchViewer,
  randomRepos,
  searchRepos,
} = require('../core/github');
const githubAuth = require('../core/github-auth');
const { detectStack, MANIFESTS } = require('../core/detect');
const { buildPlan, runtimePlan, stackForLanguage } = require('../core/plan');
const { adapterIds, describe: describeTool, supportedIds } = require('../core/runtime-install');
const { parseRepoUrl, safeDirName } = require('../core/repo-url');
const { describeLocalRepo, insideDir, localDetection, samePath, scanWorkspace } = require('../core/workspace');
const { effectivePath, resolveTool, runtimeStatus } = require('../core/tools');
const { findXcodeProject } = require('../core/xcode');
const { currentBranch, isGitRepo, localHead, pull, remoteHead } = require('../core/git');
const { checkDiskSpace } = require('../core/disk');
const { verifyInstall, verifyProject } = require('../core/verify');
const { RunManager, findLatestLocalUrl, killProcessTree, listeningPid, logSize, readLogFrom } = require('../core/runner');
// The Universal Engine configuration: the runtime catalog, the project
// categories, the compatibility rules and the workflow. It is read here, and
// it does not change how the installation flow behaves.
const engine = require('../core/engine');

const runs = new RunManager();

// One device-flow login at a time. The device code itself never reaches the
// browser: the UI only gets the short code the user has to type.
let deviceFlow = null;

// Plans this server built, keyed by the id /api/analyze handed back. A run is
// only ever started from one of these, so a request cannot describe its own
// commands and have them executed on the machine.
const analyzedPlans = new Map();
const PLAN_LIMIT = 20;

function rememberPlan(plan) {
  const planId = crypto.randomUUID();
  analyzedPlans.set(planId, plan);
  while (analyzedPlans.size > PLAN_LIMIT) analyzedPlans.delete(analyzedPlans.keys().next().value);
  return planId;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function projectId(owner, repo) {
  return `proj-${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

async function openFolder(dir) {
  if (!fs.existsSync(dir)) return false;
  let cmd = 'xdg-open';
  let args = [dir];
  if (process.platform === 'win32') {
    cmd = path.join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe');
    args = [dir];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [dir];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    return await new Promise((resolve) => {
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    });
  } catch {
    return false;
  }
}

async function openInXcode(project) {
  if (process.platform !== 'darwin') {
    throw new Error('Opening an Apple project in Xcode requires macOS.');
  }
  const settings = getSettings();
  if (!insideDir(settings.workspace, project.dir)) {
    throw new Error('The project folder is outside the GUITinstal workspace.');
  }
  const target = findXcodeProject(project.dir);
  if (!target) throw new Error('No Xcode workspace or project was found in this repository.');
  const xcode = (await runtimeStatus({ refresh: true })).find((item) => item.id === 'xcode');
  if (!xcode?.available) {
    throw new Error('Install Xcode from Apple, open it once to finish setup, then try again.');
  }
  await new Promise((resolve, reject) => {
    execFile('open', ['-a', 'Xcode', target.path], { timeout: 15000 }, (error) => {
      if (error) reject(new Error(`Xcode could not open this project: ${error.message}`));
      else resolve();
    });
  });
  return { ok: true, target: target.relative };
}

/**
 * Opens a real terminal inside the project folder. The path only ever travels
 * as the child's working directory, never as part of a command line, so a
 * folder name cannot inject anything into the shell.
 */
async function openTerminal(dir) {
  if (!fs.existsSync(dir)) return false;
  const targets =
    process.platform === 'win32'
      ? [
          {
            cmd: process.env.ComSpec || path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'cmd.exe'),
            args: ['/K'],
          },
        ]
      : process.platform === 'darwin'
        ? [{ cmd: 'open', args: ['-a', 'Terminal', dir] }]
        : [
            { cmd: 'x-terminal-emulator', args: [] },
            { cmd: 'gnome-terminal', args: [] },
            { cmd: 'xterm', args: [] },
          ];
  for (const target of targets) {
    try {
      const child = spawn(target.cmd, target.args, {
        cwd: dir,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      const started = await new Promise((resolve) => {
        child.once('error', () => resolve(false));
        child.once('spawn', () => {
          child.unref();
          resolve(true);
        });
      });
      if (started) return true;
    } catch {
      /* try the next terminal */
    }
  }
  return false;
}

function openLocalUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return false;
  }
  let cmd = 'xdg-open';
  if (process.platform === 'win32') cmd = 'explorer.exe';
  if (process.platform === 'darwin') cmd = 'open';
  try {
    spawn(cmd, [url.toString()], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* analysis                                                            */
/* ------------------------------------------------------------------ */

async function analyze(url) {
  const parsed = parseRepoUrl(url);
  if (!parsed.ok) throw new Error(parsed.error);

  const settings = getSettings();
  const token = settings.githubToken;

  const repo = await fetchRepo(parsed.owner, parsed.repo, token);
  const { entries, truncated } = await fetchTree(repo.owner, repo.name, repo.defaultBranch, token);

  const manifests = {};
  for (const name of MANIFESTS) {
    if (!entries.some((entry) => entry.path === name)) continue;
    const content = await fetchFile(repo.owner, repo.name, repo.defaultBranch, name);
    if (content) manifests[name] = content;
  }

  const detection = detectStack(entries, manifests);
  const plan = buildPlan({ repo, detection, settings, runtimes: await runtimeStatus() });

  return {
    planId: rememberPlan(plan),
    plan,
    repo,
    detection: {
      primary: detection.primary
        ? {
            stack: detection.primary.stack,
            label: detection.primary.label,
            confidence: detection.primary.confidence,
            markers: detection.primary.markers,
            frameworks: detection.primary.frameworks || [],
            scripts: Object.keys(detection.primary.scripts || {}),
            dependencyCount: detection.primary.dependencyCount || 0,
          }
        : null,
      secondary: detection.secondary,
      fileCount: detection.fileCount,
      truncated,
    },
    workspace: settings.workspace,
  };
}

/* ------------------------------------------------------------------ */
/* project registry sync                                               */
/* ------------------------------------------------------------------ */

async function registerProject(run, { phase = 'final', runStatus = 'done' } = {}) {
  const { repo, directory, stack, steps } = run.plan;
  // run.steps carries the command the runner actually resolved after the
  // Runtime Manager installed PHP. plan.steps still names the bare tool that
  // did not exist when the link was pasted.
  const launchStep = (run.steps || []).find((step) => step.id === 'launch') || steps.find((step) => step.id === 'launch');
  let launch = launchStep?.exec ? { ...launchStep.exec, command: launchStep.command } : null;
  if (launch?.cmd && !path.dirname(launch.cmd)) {
    const fresh = resolveTool(launch.cmd);
    if (!fresh.missing) {
      launch = { ...launch, cmd: fresh.cmd, args: fresh.args.concat(launch.args || []), shell: fresh.shell === true };
    }
  }
  const project = {
    id: projectId(repo.owner, repo.name),
    owner: repo.owner,
    repo: repo.name,
    name: repo.name,
    fullName: repo.fullName,
    description: repo.description,
    url: repo.url,
    cloneUrl: repo.cloneUrl || '',
    avatarUrl: repo.ownerAvatar || '',
    stack: stack.id,
    stackLabel: stack.label,
    xcodeProjectFile: run.plan.xcodeProjectFile || '',
    dir: directory,
    workspace: run.workspace,
    launch,
    status: 'installed',
    // The folder is filed even when a later step fails: a downloaded repository
    // belongs in the gallery, and hiding it until everything succeeds is how
    // clones used to disappear from the app.
    lastRunStatus: runStatus,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastCommit: '',
    branch: '',
  };

  if (await isGitRepo(directory)) {
    project.branch = await currentBranch(directory);
    project.lastCommit = (await localHead(directory)).slice(0, 7);
  }

  // Every command exiting 0 is not the same claim as the project being on
  // disk. The folder is counted here so the UI can only say "ready" with
  // files behind it, and says what is missing when there are none.
  project.verify = await verifyInstall(directory);
  // The verifier checks the project kind, not just the file count: a clone
  // with no dependency folder is installed, not launchable.
  project.installation = await verifyProject(directory, { stack: stack.id, hasLaunch: Boolean(launch) });
  project.state = project.installation.state;
  project.status = project.verify.ok ? 'installed' : 'incomplete';
  // On the first file the clone has landed but setup has not finished. Calling
  // that "installed" would be a lie, and calling it absent would be one too.
  if (phase === 'downloaded') project.status = 'downloaded';
  else if (runStatus === 'failed' || runStatus === 'cancelled') project.status = 'incomplete';
  project.installLog = run.installLog || path.join(directory, '.guitinstal', 'install.log');

  // A project whose launcher is still alive stays marked as running.
  // localUrl is the address the project serves on this machine; url above is
  // the repository page. They are different things and must never share a field.
  const launched = (run.steps || []).find((step) => step.id === 'launch');
  if (launched && launched.status === 'done') {
    // A background step settles two seconds after it spawns, which is before a
    // slow server has printed its address. By the time the install is filed the
    // log has it, so read the log again rather than saving "not running" for a
    // tool that is answering on a port right now.
    const address = launched.url || (launched.logPath ? findLatestLocalUrl(readLogFrom(launched.logPath, 0)) : '');
    const owner = (address ? await serverPid(address) : 0) || (launched.pid && isProcessAlive(launched.pid) ? launched.pid : 0);
    if (owner) {
      project.pid = owner;
      project.status = 'running';
      project.logPath = launched.logPath;
      project.startedAt = launched.startedAt;
      if (address) project.localUrl = address;
    }
  }

  upsertProject(project);
  return project;
}

/**
 * Files a run in the project library once per phase. The download write lands
 * as soon as the clone finishes; the final write upgrades the same record.
 * Writes are serialized, so a final request that arrives while the clone write
 * is still in flight waits for it instead of racing it. Returns true when a
 * write actually happened, so the caller emits one fresh snapshot.
 */
function archiveRunLibrary(run, { phase, runStatus }) {
  const archive = run.archive || (run.archive = { phase: 'none', phasePromise: null, attempts: 0 });

  const write = async () => {
    // Never downgrade a final entry and never write the same phase twice.
    if (archive.phase === 'final' || archive.phase === phase) return false;
    // A failing database gets a few retries, not an endless loop.
    if (archive.attempts >= 4) return false;
    archive.attempts += 1;
    try {
      const project = await registerProject(run, { phase, runStatus });
      archive.phase = phase;
      run.library = { ok: true, attempts: archive.attempts, id: project.id, status: project.status, phase };
      run.verification = project.verify;
    } catch (error) {
      // Losing the library entry is worth reporting; breaking the run is not.
      run.library = { ok: false, attempts: archive.attempts, error: error.message, phase };
    }
    return true;
  };

  const next = (archive.phasePromise || Promise.resolve()).then(write);
  archive.phasePromise = next.catch(() => false);
  return next;
}

/**
 * Re-reads a project folder and stores what is actually on disk. Used for the
 * projects recorded before the install checks existed, and every time the user
 * opens the Updates view, so a deleted folder cannot keep showing as installed.
 */
async function recheckProject(project) {
  const verify = await verifyInstall(project.dir);
  const next = {
    ...project,
    verify,
    status: verify.ok ? (project.pid && isProcessAlive(project.pid) ? 'running' : 'installed') : 'incomplete',
    lastCommit: verify.commit || project.lastCommit,
    branch: verify.branch || project.branch,
    installLog: project.installLog || path.join(project.dir, '.guitinstal', 'install.log'),
  };
  // Projects recorded before the avatar was stored have nothing to show, so this
  // is the one place that backfills it. A GitHub failure must not fail the recheck.
  if (!next.avatarUrl && next.url) {
    try {
      const fresh = await fetchRepo(next.url);
      next.avatarUrl = fresh.ownerAvatar || '';
      next.description = next.description || fresh.description || '';
      next.language = next.language || fresh.language || '';
    } catch {
      /* the card keeps the app icon until GitHub answers */
    }
  }
  upsertProject(next);
  return next;
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which process owns the address the project serves on.
 * npm starts the server as its own child and can exit first, so the pid the app
 * spawned is not always the one worth showing as running or stopping.
 */
async function serverPid(url) {
  if (!url) return 0;
  const parsed = new URL(url);
  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  return listeningPid(port);
}

/** The port named by an "address already in use" failure, or 0. */
function portInAddressError(text) {
  const inUse = String(text || '').match(/EADDRINUSE[^\r\n]*?:(\d{2,5})\b/i);
  if (inUse) return Number(inUse[1]);
  const dump = String(text || '').match(/\bport:\s*(\d{2,5})\b/i);
  return dump ? Number(dump[1]) : 0;
}

/**
 * Stores a project as installed again. upsertProject merges with the record on
 * disk, so the launcher fields have to be cleared by name: dropping them from
 * the object leaves the dead pid behind.
 */
function markInstalled(project, extra = {}) {
  return upsertProject({
    ...project,
    pid: null,
    logPath: null,
    startedAt: null,
    localUrl: null,
    status: 'installed',
    updatedAt: new Date().toISOString(),
    ...extra,
  });
}

/**
 * The start command for an installed folder, rebuilt from what is on disk.
 * Records written by older versions (and rows migrated from the old
 * projects.json) carry no launcher, and telling a user "there is no way to run
 * this" about a project that is really installed would be a lie about the
 * product.
 */
function deriveLaunch(project, knownDetection = null) {
  const detection = knownDetection || localDetection(project.dir);
  if (!detection?.primary) return null;
  try {
    const plan = buildPlan({
      repo: {
        owner: project.owner || '',
        // The folder name is what sourceStep joins to the workspace. Using the
        // repository name here would point at a different folder whenever the
        // two differ, and the plan would refuse to derive a launcher.
        name: path.basename(project.dir) || project.repo || project.name || '',
        fullName: project.fullName || '',
        url: project.url || '',
        cloneUrl: project.cloneUrl || `${project.url || 'https://github.com'}.git`,
        description: project.description || '',
        stars: 0,
        forks: 0,
        license: '',
        language: '',
        defaultBranch: project.branch || 'main',
        ownerAvatar: '',
        pushedAt: '',
      },
      detection,
      settings: { ...getSettings(), workspace: path.dirname(project.dir) },
      runtimes: [],
    });
    const launch = (plan.steps || []).find((step) => step.id === 'launch');
    return launch?.exec ? { ...launch.exec, command: launch.command } : null;
  } catch {
    return null;
  }
}

function localProjectId(info, directory) {
  if (info.owner && info.repo) return projectId(info.owner, info.repo);
  const digest = crypto.createHash('sha1').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 12);
  return `proj-local-${digest}`;
}

/**
 * Adopts a repository that is already on disk. Used by the workspace gallery:
 * a clone downloaded before the library existed (or by another tool) becomes a
 * normal project with its start command and disk verification, without cloning
 * it a second time.
 */
async function importWorkspaceProject(directory) {
  const settings = getSettings();
  const dir = path.resolve(String(directory || ''));
  if (!insideDir(settings.workspace, dir)) {
    throw new Error('That folder is outside the workspace. Only repositories inside the workspace can be added.');
  }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    throw new Error('That folder is not a Git repository, so GUITinstal cannot confirm which project it holds.');
  }

  const info = describeLocalRepo(dir);
  const id = localProjectId(info, dir);
  const previous = getProject(id);

  let remote = null;
  if (info.owner && info.repo) {
    try {
      remote = await fetchRepo(info.owner, info.repo, settings.githubToken);
    } catch {
      /* the local files are enough; GitHub metadata is a bonus */
    }
  }

  const verify = await verifyInstall(dir);
  const detectedStack = info.stack !== 'unknown' ? info.stack : stackForLanguage(remote?.language) || 'unknown';
  const now = new Date().toISOString();
  const project = {
    id,
    owner: info.owner,
    repo: info.repo,
    name: info.name,
    fullName: remote?.fullName || info.fullName,
    description: remote?.description || previous?.description || '',
    url: remote?.url || info.url || previous?.url || '',
    cloneUrl: info.remote || previous?.cloneUrl || '',
    avatarUrl: remote?.ownerAvatar || previous?.avatarUrl || '',
    language: remote?.language || previous?.language || '',
    stack: detectedStack,
    stackLabel: info.stack !== 'unknown' ? info.stackLabel : remote?.language || previous?.stackLabel || 'Generic project',
    xcodeProjectFile: info.xcodeProjectFile || '',
    dir,
    workspace: settings.workspace,
    launch: null,
    status: verify.ok ? 'installed' : 'incomplete',
    updatedAt: now,
    lastCommit: verify.commit || '',
    branch: verify.branch || '',
    verify,
    installLog: previous?.installLog || path.join(dir, '.guitinstal', 'install.log'),
    imported: true,
    importedAt: previous?.importedAt || now,
  };
  if (!previous) project.installedAt = now;
  project.launch = deriveLaunch(project, info.detection);
  upsertProject(project);
  return project;
}

/** Every Git repository in the workspace, with library membership attached. */
function workspaceGallery() {
  const settings = getSettings();
  const saved = listProjects();
  return {
    workspace: settings.workspace,
    items: scanWorkspace(settings.workspace).map((item) => {
      const registered = saved.find(
        (project) =>
          samePath(project.dir, item.dir) ||
          (item.owner && String(project.fullName || '').toLowerCase() === item.fullName.toLowerCase())
      );
      return {
        dir: item.dir,
        name: item.name,
        owner: item.owner,
        repo: item.repo,
        fullName: item.fullName,
        url: item.url,
        remote: item.remote,
        stack: item.stack,
        stackLabel: item.stackLabel,
        markers: item.markers,
        registered: Boolean(registered),
        projectId: registered?.id || '',
      };
    }),
  };
}

async function waitForLocalUrl(logPath, child, fromByte, timeoutMs = 5000) {
  const stop = Date.now() + timeoutMs;
  while (Date.now() < stop) {
    const url = findLatestLocalUrl(readLogFrom(logPath, fromByte));
    if (url) return url;
    if (child.exitCode !== null) return '';
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return '';
}

/** Starts a project in the background and records how to stop it. */
async function startProject(project) {
  // A record without a stored launcher is not "a project that cannot run":
  // rebuild the command from the files on disk before giving up.
  let launch = project.launch?.cmd ? project.launch : deriveLaunch(project);
  if (!launch?.cmd) {
    // "No start command" is the normal outcome for a library, not a broken app,
    // so the message says what the project is and what to do next instead of
    // sending the user to a terminal without a reason.
    const label = project.stackLabel || project.stack || 'This project';
    throw new Error(
      `${project.fullName || project.name} has no start command. ${label} projects of this kind usually build a library, not a program, so there is nothing for GUITinstal to launch. The files are installed and the folder is intact: open the README, or use the Terminal button to run the command the project documents.`
    );
  }
  // The launcher may have been written before the runtime existed. Resolve the
  // bare tool name against the paths GUITinstal manages, so Run works after a
  // restart instead of failing with ENOENT.
  if (!path.dirname(launch.cmd)) {
    const fresh = resolveTool(launch.cmd);
    if (fresh.missing) {
      throw new Error(
        `This project starts with ${launch.cmd}, which is not installed here. Open the project Tools panel and install it, then try Run again.`
      );
    }
    launch = { ...launch, cmd: fresh.cmd, args: fresh.args.concat(launch.args || []), shell: fresh.shell === true };
  }
  if (path.isAbsolute(launch.cmd) && !fs.existsSync(launch.cmd)) {
    throw new Error(
      `The runtime this project uses is no longer at ${launch.cmd}. Open the project Tools panel and install it again.`
    );
  }
  if (project.launch?.cmd !== launch.cmd || project.launch?.args?.join('\u0000') !== (launch.args || []).join('\u0000')) {
    upsertProject({ ...project, launch, updatedAt: new Date().toISOString() });
  }
  if (project.pid && isProcessAlive(project.pid)) throw new Error('This project is already running.');

  const logDir = path.join(project.dir, '.guitinstal');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'launch.log');
  const logStart = logSize(logPath);
  const fd = fs.openSync(logPath, 'a');

  const child = spawn(launch.cmd, launch.args || [], {
    cwd: project.dir,
    // Detaching gives the tree a fresh console on Windows, where npm's own
    // cmd.exe shows a black window for the user's tool; non-detached children
    // still outlive this app (measured) and inherit the hidden console.
    detached: process.platform !== 'win32',
    shell: launch.shell === true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    // The launched app has to see the PHP, Composer and other tools that live
    // in <userData>/tools, not only the PATH the desktop app started with.
    env: { ...process.env, FORCE_COLOR: '0', PATH: effectivePath() },
  });

  let exitCode = null;
  child.on('exit', (code, signal) => {
    exitCode = code === null ? signal : code;
  });

  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } finally {
    fs.closeSync(fd);
  }
  child.unref();

  const running = {
    ...project,
    launch,
    pid: child.pid,
    logPath,
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  upsertProject(running);

  const url = await waitForLocalUrl(logPath, child, logStart);
  // npm can exit while the server it spawned keeps answering, so the record
  // stores whoever owns the address rather than the wrapper that was spawned.
  const owner = (await serverPid(url)) || child.pid;
  if (url) upsertProject({ ...running, localUrl: url, pid: owner });

  // A launcher that dies at once used to be reported as a success, which left
  // the user staring at a button that did nothing. Say what happened instead.
  if (exitCode === null) await new Promise((resolve) => setTimeout(resolve, 800));
  if (exitCode !== null && !url) {
    markInstalled(project, { lastExit: exitCode });
    const busy = portInAddressError(readLogFrom(logPath, logStart));
    if (busy) {
      const holder = await listeningPid(busy);
      throw new Error(
        `Port ${busy} is already in use${holder ? ` by process ${holder}` : ''}, so this project could not start. If that server is this project still running from the install, open http://127.0.0.1:${busy}/ instead of starting it again.`
      );
    }
    const reason = tailLog(logPath, 3).join(' / ').slice(0, 220);
    throw new Error(
      `It stopped right away (exit ${exitCode}).${reason ? ` Last output: ${reason}` : ' Open a terminal in the folder to run the command yourself.'}`,
    );
  }
  return { ok: true, pid: owner, logPath, url, command: launch.command || '' };
}

/** Stops a project started by the app. */
async function stopProject(project) {
  if (!project.pid) throw new Error('This project is not running.');
  const logPath = project.logPath || null;
  if (!isProcessAlive(project.pid)) {
    markInstalled(project);
    return { ok: true, alreadyStopped: true };
  }
  await killProcessTree(project.pid);
  markInstalled(project, { stoppedAt: new Date().toISOString() });
  return { ok: true, logPath };
}

function tailLog(file, lines = 120) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return content.split(/\r?\n/).filter((line) => line.trim().length).slice(-lines);
  } catch {
    return [];
  }
}

/**
 * The launcher log explains a project that was started; when nothing was ever
 * launched, the install record explains what the installer actually did. The
 * LOG button has to show one of the two, never an empty box.
 */
function projectLog(project) {
  const launch = project.logPath ? tailLog(project.logPath) : [];
  if (launch.length) return { lines: launch, path: project.logPath, source: 'launch' };
  const install = path.join(project.dir, '.guitinstal', 'install.log');
  const history = tailLog(install);
  if (history.length) return { lines: history, path: install, source: 'install' };
  return { lines: [], path: project.logPath || install, source: 'none' };
}

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * The two facts a Home card has to be honest about: whether GUITinstal has a
 * builder for this repository language, and whether the user already starred it.
 */
function withDiscoverFlags(item, saved) {
  const stack = stackForLanguage(item.language);
  return {
    ...item,
    stack: stack || '',
    installable: Boolean(stack),
    favorite: (saved || []).some((row) => row.fullName === item.fullName),
  };
}
const routes = [
  {
    method: 'GET',
    path: /^\/api\/health$/,
    handler: async () => ({ ok: true, name: 'GUITinstal', version: changelog.packageVersion() }),
  },
  {
    // What this build says about itself: the version it is, and the changelog
    // entry written for exactly that version — read from the file that ships
    // with the app, so it works offline and cannot drift from package.json.
    method: 'GET',
    path: /^\/api\/whats-new$/,
    handler: async () => changelog.latest(),
  },
  {
    method: 'GET',
    path: /^\/api\/state$/,
    handler: async () => {
      const settings = getSettings();
      const projects = listProjects().map((project) => {
        if (!project.pid) return project;
        // The launcher may have died on its own: do not show it as running.
        if (isProcessAlive(project.pid)) return project;
        return markInstalled(project, { stoppedAt: new Date().toISOString() });
      }).map((project) => ({
        ...project,
        xcodeProjectFile: findXcodeProject(project.dir)?.relative || '',
      }));
      return {
        platform: process.platform,
        settings: publicSettings(settings),
        projects,
        runtimes: await runtimeStatus(),
        // Which of the missing chips GUITinstal can fix by itself right now.
        installableRuntimes: supportedIds(),
        runtimeAdapters: adapterIds(),
        workspace: settings.workspace,
        defaultWorkspace: defaultWorkspace(),
        workspaceExists: fs.existsSync(settings.workspace),
        dataDirectory: userDataDir(),
        library: libraryStatus(),
        token: tokenStatus(),
      };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/runtimes\/refresh$/,
    handler: async () => {
      // Re-scan PATH so tools installed while the app was open become visible.
      const runtimes = await runtimeStatus({ refresh: true });
      return {
        runtimes,
        available: runtimes.filter((runtime) => runtime.available).map((runtime) => runtime.id),
        missing: runtimes.filter((runtime) => !runtime.available).map((runtime) => runtime.id),
      };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/runtimes\/prepare$/,
    handler: async (req) => {
      // The plan is built here from GUITinstal's own catalog, never from the
      // request: a browser can only name a tool, not describe a command.
      const body = await readJsonBody(req);
      const id = String(body.id || '').trim();
      if (!supportedIds().includes(id)) {
        throw new Error(`GUITinstal has no built-in installer for "${id}" on this machine. Use the official download page instead.`);
      }
      const plan = runtimePlan(id);
      // Same shape /api/analyze returns, so the UI can show this plan with the
      // approval buttons, the step log and the console it already has.
      return { planId: rememberPlan(plan), plan, repo: plan.repo, detection: { secondary: [] } };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/workspace\/open$/,
    handler: async () => {
      const settings = getSettings();
      if (!fs.existsSync(settings.workspace)) {
        fs.mkdirSync(settings.workspace, { recursive: true });
      }
      return { ok: await openFolder(settings.workspace) };
    },
  },
  {
    method: 'GET',
    path: /^\/api\/workspace\/repos$/,
    handler: async () => workspaceGallery(),
  },
  {
    method: 'POST',
    path: /^\/api\/workspace\/repos$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const project = await importWorkspaceProject(body.directory);
      return { ok: true, project };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/workspace\/repos\/open$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const settings = getSettings();
      const dir = path.resolve(String(body.directory || ''));
      if (!insideDir(settings.workspace, dir)) throw new Error('That folder is outside the workspace.');
      return { ok: await openFolder(dir) };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/settings$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const settings = updateSettingsFromBody(body);
      return { settings: publicSettings(settings) };
    },
  },
  {
    method: 'GET',
    path: /^\/api\/ai\/local$/,
    handler: async () => ({ localAI: localAi.getStatus() }),
  },
  {
    method: 'POST',
    path: /^\/api\/ai\/local\/install$/,
    handler: async () => ({ localAI: await localAi.install() }),
  },
  {
    method: 'POST',
    path: /^\/api\/ai\/local\/vision$/,
    handler: async () => ({ localAI: await localAi.installVision() }),
  },
  {
    method: 'POST',
    path: /^\/api\/ai\/local\/cancel$/,
    handler: async () => ({ localAI: localAi.cancelInstall() }),
  },
  {
    method: 'DELETE',
    path: /^\/api\/ai\/local$/,
    handler: async () => ({ localAI: await localAi.remove() }),
  },
  {
    method: 'GET',
    path: /^\/api\/ai\/providers$/,
    handler: async () => ({ providers: listAiProviders() }),
  },
  {
    method: 'POST',
    path: /^\/api\/ai\/providers$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      return { provider: saveAiProvider(body) };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/ai\/providers\/reorder$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      return { providers: reorderAiProviders(body.ids) };
    },
  },
  {
    method: 'DELETE',
    path: /^\/api\/ai\/providers\/([\w-]+)$/,
    handler: async (req, params) => {
      removeAiProvider(params[0]);
      return { ok: true };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/github-auth\/start$/,
    handler: async () => {
      const session = await githubAuth.start();
      deviceFlow = session;
      return {
        userCode: session.userCode,
        verificationUri: session.verificationUri,
        verificationUriComplete: session.verificationUriComplete,
        interval: session.interval,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/github-auth\/poll$/,
    handler: async () => {
      if (!deviceFlow) return { status: 'idle' };
      if (Date.now() > deviceFlow.expiresAt) {
        deviceFlow = null;
        return { status: 'expired' };
      }

      const result = await githubAuth.poll(deviceFlow.deviceCode);
      if (result.status !== 'connected') {
        return { status: result.status, ...(result.intervalUp ? { interval: deviceFlow.interval + 5 } : {}) };
      }

      deviceFlow = null;
      const settings = updateSettings({ githubToken: result.accessToken });
      return { status: 'connected', scope: result.scope, settings: publicSettings(settings) };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/github-auth\/cancel$/,
    handler: async () => {
      deviceFlow = null;
      return { ok: true };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/github-auth\/check$/,
    handler: async () => {
      const settings = getSettings();
      if (!settings.githubToken) {
        return { status: 'signed-out', account: null, token: tokenStatus(), settings: publicSettings(settings) };
      }

      try {
        const viewer = await fetchViewer(settings.githubToken);
        const updated = updateSettings({
          githubUser: viewer.login,
          githubAvatar: viewer.avatarUrl,
          githubCheckedAt: new Date().toISOString(),
        });
        return { status: 'connected', account: viewer, token: tokenStatus(), settings: publicSettings(updated) };
      } catch (error) {
        if (error.code === 'token-invalid') {
          // GitHub says the token is dead; keeping it would only fail every call.
          const cleared = updateSettings({ githubToken: '', githubUser: '', githubAvatar: '', githubCheckedAt: '' });
          return { status: 'expired', account: null, message: error.message, token: tokenStatus(), settings: publicSettings(cleared) };
        }
        throw error;
      }
    },
  },
  {
    method: 'POST',
    path: /^\/api\/github-auth\/disconnect$/,
    handler: async () => {
      // Removes this machine's copy only. To revoke it everywhere, delete it at
      // github.com/settings/tokens.
      const settings = updateSettings({
        githubToken: '',
        githubUser: '',
        githubAvatar: '',
        githubScope: '',
        githubCheckedAt: '',
      });
      return { status: 'signed-out', token: tokenStatus(), settings: publicSettings(settings) };
    },
  },

  {
    method: 'POST',
    path: /^\/api\/analyze$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (!body.url) throw new Error('Enter the repository URL.');
      return analyze(body.url);
    },
  },
  {
    method: 'POST',
    path: /^\/api\/assistant$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const question = String(body.question || '').trim().slice(0, 300);
      if (!question) throw new Error('Type what you want to know about this project.');
      const history = body.history === undefined ? [] : body.history;
      if (!Array.isArray(history) || history.length > 12) {
        throw new Error('Conversation history must contain at most six user/assistant exchanges.');
      }
      const conversation = history.map((turn) => {
        if (
          !turn ||
          !['user', 'assistant'].includes(turn.role) ||
          typeof turn.content !== 'string' ||
          !turn.content.trim() ||
          turn.content.length > 1800
        ) {
          throw new Error('Conversation history contains an invalid message.');
        }
        return { role: turn.role, content: turn.content.trim() };
      });
      if (conversation.some((turn, index) => turn.role !== (index % 2 === 0 ? 'user' : 'assistant'))) {
        throw new Error('Conversation history must alternate between user and assistant messages.');
      }

      let context = {};
      if (body.projectId) {
        const project = findProject(String(body.projectId));
        context = {
          project,
          log: projectLog(project),
          verify: project.verify || (await verifyInstall(project.dir)),
          guide: projectGuide(project.dir),
        };
      } else if (body.runId) {
        const run = runs.get(String(body.runId));
        if (!run) throw new Error('That terminal run is no longer available. Start the project again and retry.');
        context = {
          plan: { ...run.plan, steps: run.steps },
          log: {
            lines: run.steps.flatMap((step) => (step.output || []).slice(-40).map((line) => line.text)),
            source: 'install run',
          },
        };
      } else if (body.planId) {
        const plan = analyzedPlans.get(String(body.planId));
        if (!plan) throw new Error('That analysis is no longer in memory. Analyze the repository again.');
        context = { plan };
      }
      const imageDataUrl = String(body.imageDataUrl || '');
      if (imageDataUrl && !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl)) {
        throw new Error('Only a JPEG screenshot captured inside GUITinstal can be analyzed.');
      }
      if (imageDataUrl && Buffer.from(imageDataUrl.slice(imageDataUrl.indexOf(',') + 1), 'base64').length > 1024 * 1024) {
        throw new Error('The screenshot is too large. Capture a smaller image and try again.');
      }
      return {
        answer: await answerWithAI(question, context, body.useAI === true, imageDataUrl, conversation),
        question,
      };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/assistant\/repair-proposal$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (body.sendFile !== true) throw new Error('Confirm that you want to send this selected file to a configured no-cost provider.');
      const project = findProject(String(body.projectId || ''));
      const file = readProjectFile(project.dir, body.filePath);
      const context = {
        project,
        log: projectLog(project),
        verify: project.verify || (await verifyInstall(project.dir)),
      };
      const proposal = await suggestFileRepair({
        question: String(body.question || 'Explain the error and repair this file').slice(0, 300),
        context,
        relativePath: file.relativePath,
        content: file.content,
      });
      return {
        ...proposal,
        filePath: file.relativePath,
        originalContent: file.content,
        expectedSha256: file.sha256,
      };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/assistant\/apply-repair$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (body.approved !== true) throw new Error('Approve the proposed change before applying it.');
      const project = findProject(String(body.projectId || ''));
      return {
        ok: true,
        ...applyProjectFile(project.dir, body.filePath, body.expectedSha256, body.replacement),
      };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/discover$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const settings = getSettings();
      const mode = ['trending', 'recent', 'popular', 'favorites', 'mine', 'random', 'search'].includes(body.mode)
        ? body.mode
        : 'search';
      const language = String(body.language || '').replace(/[^A-Za-z0-9.#+-]/g, '').slice(0, 30);
      const query = String(body.q || '').trim().slice(0, 120);

      if (mode === 'favorites') {
        const saved = listFavorites();
        const items = saved.map((row) =>
          withDiscoverFlags(
            {
              owner: row.owner,
              name: row.name,
              fullName: row.fullName,
              description: row.description || '',
              url: row.url,
              stars: row.stars || 0,
              forks: 0,
              ownerAvatar: row.avatarUrl || '',
              pushedAt: '',
              language: row.language || '',
              license: '',
              updatedAt: '',
              savedAt: row.addedAt || '',
              topics: [],
            },
            saved
          )
        );
        return { total: items.length, items, mode, label: 'Favorites', trending: false };
      }

      if (mode === 'mine') {
        if (!settings.githubToken) {
          return {
            total: 0,
            items: [],
            mode,
            label: 'My public repositories',
            note: 'Sign in with GitHub in Settings to browse your public repositories. GUITinstal does not request access to private repositories.',
            trending: false,
          };
        }
        const account = settings.githubUser || (await fetchViewer(settings.githubToken)).login;
        const page = await fetchUserRepos(account);
        const saved = listFavorites();
        return {
          ...page,
          items: page.items.map((item) => withDiscoverFlags(item, saved)),
          mode,
          label: 'My public repositories',
          note: 'Showing up to 100 public repositories owned by your GitHub account, most recently updated first. Private repositories are not accessed.',
          trending: false,
        };
      }

      let page;
      if (mode === 'search') {
        if (!query) return { total: 0, items: [], mode, label: 'Search', trending: false };
        page = await searchRepos(query, settings.githubToken, { sort: body.sort || 'stars' });
      } else if (mode === 'random') {
        page = await randomRepos({ language, token: settings.githubToken });
      } else {
        page = await browseRepos({ mode: mode === 'trending' ? 'popular' : mode, language, token: settings.githubToken });
      }

      const saved = listFavorites();
      recordRepoStats(page.items);

      if (mode !== 'trending') {
        return {
          ...page,
          items: page.items.map((item) => withDiscoverFlags(item, saved)),
          mode,
          label:
            mode === 'recent'
              ? 'Recently updated'
              : mode === 'popular'
                ? 'Popular'
                : mode === 'random'
                  ? 'Community picks'
                  : 'Search',
          note:
            mode === 'random'
              ? 'Drawn at random from public GitHub: a topic, a star floor and a page are picked each time, then the results are shuffled. Press Surprise me again for another set.'
              : undefined,
          trending: false,
        };
      }

      // "Trending" is a claim about change, so it can only be made from the star
      // history this machine keeps. One sighting is not growth, so it says Popular.
      const growth = new Map(growthByRepo(60).map((row) => [row.fullName, row]));
      const scored = page.items
        .map((item) => {
          const seen = growth.get(item.fullName);
          const proven = seen && seen.growth > 0 && seen.spanHours >= 1;
          return withDiscoverFlags(
            {
              ...item,
              growth: seen ? seen.growth : 0,
              trending: Boolean(proven),
              spanHours: seen ? Math.round(seen.spanHours) : 0,
            },
            saved
          );
        })
        .sort((a, b) => b.growth - a.growth);
      const provenList = scored.filter((item) => item.trending);

      if (!provenList.length) {
        return {
          ...page,
          mode,
          label: 'Popular',
          trending: false,
          note: 'Trending needs proof of growth. This machine has only seen these repositories once, so they are listed as Popular. Browse again later and the ones gaining stars show as Trending.',
          items: scored,
        };
      }

      return { ...page, mode, label: 'Trending', trending: true, items: provenList };
    },
  },
  {
    method: 'GET',
    path: /^\/api\/favorites$/,
    handler: async () => ({ items: listFavorites() }),
  },
  {
    method: 'POST',
    path: /^\/api\/favorites$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const fullName = String(body.fullName || '').trim();
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new Error('That is not a repository name.');
      const saved = addFavorite({ ...body, fullName });
      return { ok: true, item: saved, items: listFavorites() };
    },
  },
  {
    method: 'DELETE',
    path: /^\/api\/favorites\/([\w.-]+\/[\w.-]+)$/,
    handler: async (req, params) => ({ ok: removeFavorite(params[0]), items: listFavorites() }),
  },
  {
    method: 'POST',
    path: /^\/api\/runs$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const plan = analyzedPlans.get(body.planId);
      if (!plan?.steps?.length) {
        throw new Error('This plan is no longer available. Analyze the repository again.');
      }
      const settings = getSettings();
      // The clone step runs from the workspace, so it has to exist first.
      fs.mkdirSync(settings.workspace, { recursive: true });

      const disk = checkDiskSpace(settings.workspace);
      if (disk.level === 'block') {
        throw new Error(disk.message);
      }

      // The compatibility verdict is enforced here, not only shown: a project
      // whose runtime has no build for this platform cannot start a run, so
      // the Install button can never pretend it might work.
      if (plan.compatibility?.verdict === 'blocked') {
        const reasons = (plan.compatibility.blocked || []).map((item) => item.reason).join(' ');
        throw new Error(`This project cannot be installed on this machine. ${reasons}`.trim());
      }

      const run = runs.create(plan, { workspace: settings.workspace });

      // The repository joins the gallery as soon as its clone lands, not only
      // when the last install command succeeds. A project that stopped halfway
      // is still worth keeping, and hiding it was how downloaded repositories
      // disappeared from the app. The terminal snapshot waits for the final
      // write, so "done" and "filed in the library" mean the same thing.
      if (plan.kind !== 'runtime') {
        run.beforeSettle = async (status) => {
          const clone = run.steps.find((step) => step.id === 'clone');
          if (clone?.status !== 'done') return;
          await archiveRunLibrary(run, { phase: 'final', runStatus: status });
        };
      }

      runs.subscribe(run.id, async (snapshot) => {
        const finished = runs.get(run.id);
        if (!finished) return;

        // A tool install is not a project: nothing lands in the library, the
        // only proof that matters is that the tool now answers on the PATH.
        if (finished.plan?.kind === 'runtime') {
          if (snapshot.status !== 'done') return;
          const refreshed = await runtimeStatus({ refresh: true });
          const found = refreshed.find((runtime) => runtime.id === finished.plan.requiredRuntimes[0]);
          finished.runtimeSetup = found?.available
            ? { ok: true, id: found.id, version: found.version }
            : { ok: false, id: finished.plan.requiredRuntimes[0] };
          runs.emit(finished);
          return;
        }

        const clone = snapshot.steps.find((step) => step.id === 'clone');
        const cloneDone = Boolean(clone && clone.status === 'done');
        const final = ['done', 'failed', 'cancelled'].includes(snapshot.status);

        if (!cloneDone) {
          // No repository was downloaded, so there is nothing to file. A plan
          // without a clone step still gets its folder verified when it ends.
          if (snapshot.status === 'done' && !finished.library) {
            try {
              finished.verification = await verifyInstall(finished.plan.directory);
            } catch {
              finished.verification = null;
            }
            finished.library = { ok: true, attempts: 1, id: '', status: 'verified', phase: 'final' };
            runs.emit(finished);
          }
          return;
        }

        const phase = final ? 'final' : 'downloaded';
        if (await archiveRunLibrary(finished, { phase, runStatus: snapshot.status })) {
          runs.emit(finished);
        }
      });

      return runs.snapshot(run);
    },
  },
  {
    method: 'GET',
    path: /^\/api\/runs\/([\w-]+)$/,
    handler: async (req, params) => {
      const run = runs.get(params[0]);
      if (!run) throw new Error('Run not found.');
      return runs.snapshot(run);
    },
  },
  {
    method: 'POST',
    path: /^\/api\/runs\/([\w-]+)\/approve$/,
    handler: async (req, params) => {
      const body = await readJsonBody(req);
      const run = runs.get(params[0]);
      if (!run) throw new Error('Run not found.');
      if (body.stepId) return runs.approve(run.id, body.stepId);
      return runs.approveAll(run.id);
    },
  },
  {
    method: 'POST',
    path: /^\/api\/runs\/([\w-]+)\/skip$/,
    handler: async (req, params) => {
      const body = await readJsonBody(req);
      return runs.skip(params[0], body.stepId);
    },
  },
  {
    // Types an answer into the command that is currently asking a question.
    method: 'POST',
    path: /^\/api\/runs\/([\w-]+)\/input$/,
    handler: async (req, params) => {
      const body = await readJsonBody(req);
      return runs.sendInput(params[0], body.text);
    },
  },
  {
    method: 'POST',
    path: /^\/api\/runs\/([\w-]+)\/cancel$/,
    handler: async (req, params) => {
      return runs.cancel(params[0]);
    },
  },
  {
    method: 'GET',
    path: /^\/api\/projects\/([\w-]+)\/updates$/,
    handler: async (req, params) => {
      const project = findProject(params[0]);
      const settings = getSettings();
      if (!(await isGitRepo(project.dir))) {
        return { available: false, reason: 'The folder is not a Git repository.' };
      }
      const branch = project.branch || (await currentBranch(project.dir));
      const local = await localHead(project.dir);
      const remote = await remoteHead(project.dir);
      const commits = await fetchCommits(project.owner, project.repo, branch || 'HEAD', settings.githubToken).catch(() => []);
      return {
        available: Boolean(remote && local && remote !== local),
        branch,
        local: local.slice(0, 7),
        remote: remote.slice(0, 7),
        commits: commits.slice(0, 5),
      };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/projects\/([\w-]+)\/update$/,
    handler: async (req, params) => {
      const project = findProject(params[0]);
      const result = await pull(project.dir);
      if (result.failed) throw new Error(result.stderr || 'git pull failed.');
      const head = await localHead(project.dir);
      upsertProject({ ...project, lastCommit: head.slice(0, 7), updatedAt: new Date().toISOString() });
      return { ok: true, output: result.stdout, lastCommit: head.slice(0, 7) };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/projects\/([\w-]+)\/launch$/,
    handler: async (req, params) => {
      const project = findProject(params[0]);
      return startProject(project);
    },
  },
  {
    method: 'POST',
    path: /^\/api\/projects\/([\w-]+)\/stop$/,
    handler: async (req, params) => {
      const project = findProject(params[0]);
      return stopProject(project);
    },
  },
  {
    method: 'GET',
    path: /^\/api\/projects\/([\w-]+)\/log$/,
    handler: async (req, params) => {
      const project = findProject(params[0]);
      return projectLog(project);
    },
  },
  {
    method: 'POST',
    path: /^\/api\/projects\/([\w-]+)\/recheck$/,
    handler: async (req, params) => recheckProject(findProject(params[0])),
  },
  {
    method: 'POST',
    path: /^\/api\/projects\/([\w-]+)\/browse$/,
    handler: async (req, params) => {
      const project = findProject(params[0]);
      // localUrl is the address this machine is serving. The repository page is
      // never opened from here, or "Open app" would silently leave the product.
      if (!project.localUrl) throw new Error('This project is not serving a local address yet. Start it first.');
      return { ok: openLocalUrl(project.localUrl), url: project.localUrl };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/projects\/([\w-]+)\/terminal$/,
    handler: async (req, params) => {
      const project = findProject(params[0]);
      return { ok: await openTerminal(project.dir), dir: project.dir };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/projects\/([\w-]+)\/open$/,
    handler: async (req, params) => {
      const project = findProject(params[0]);
      const ok = await openFolder(project.dir);
      return { ok };
    },
  },
  {
    method: 'POST',
    path: /^\/api\/projects\/([\w-]+)\/xcode$/,
    handler: async (req, params) => openInXcode(findProject(params[0])),
  },
  {
    method: 'DELETE',
    path: /^\/api\/projects\/([\w-]+)$/,
    handler: async (req, params) => {
      const project = findProject(params[0]);
      const removed = removeProject(project.id);
      return { ok: removed };
    },
  },

  /* ------------------------------------------------------------------ */
  /* Universal Engine                                                     */
  /*                                                                     */
  /* These routes expose the engine configuration. They read it and      */
  /* validate it; they never install anything and never change how the   */
  /* existing installation flow behaves.                                 */
  /* ------------------------------------------------------------------ */
  {
    method: 'GET',
    path: /^\/api\/engine\/config$/,
    handler: async () => engine.config(),
  },
  {
    method: 'GET',
    path: /^\/api\/engine\/summary$/,
    handler: async () => ({ summary: engine.summary(), capabilities: await engine.capabilities() }),
  },
  {
    method: 'GET',
    path: /^\/api\/engine\/catalog$/,
    handler: async () => ({
      engine: engine.catalog.engine(),
      ecosystems: engine.catalog.ecosystems(),
      runtimes: engine.catalog.runtimes(),
      stacks: engine.catalog.stacks(),
      digest: engine.catalog.digest(),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/engine\/workflow$/,
    handler: async () => ({
      steps: engine.workflow.steps(),
      modules: engine.workflow.modules(),
      gaps: engine.workflow.gaps(),
    }),
  },
  {
    method: 'GET',
    path: /^\/api\/engine\/capabilities$/,
    handler: async () => engine.capabilities(),
  },
  {
    method: 'POST',
    path: /^\/api\/engine\/requirements$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const id = String(body.stack || '').trim();
      const available = (await runtimeStatus()).filter((item) => item.available).map((item) => item.id);
      return engine.requirements.resolve(id, available, {
        packageManager: String(body.packageManager || '').trim(),
      });
    },
  },
  {
    method: 'POST',
    path: /^\/api\/engine\/validate$/,
    handler: async () => engine.validateLive(),
  },
  {
    method: 'POST',
    path: /^\/api\/engine\/classify$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const entries = Array.isArray(body.entries) ? body.entries : [];
      const manifests = body.manifests && typeof body.manifests === 'object' ? body.manifests : {};
      // The detection is built here, never taken from the request: the browser
      // may describe a repository, but it does not get to describe the answer.
      const detection = detectStack(entries, manifests);
      const result = engine.projectType.classify({
        entries,
        manifests,
        detection,
        repo: body.repo && typeof body.repo === 'object' ? body.repo : {},
      });
      return { detection, project: result };
    },
  },
];

function findProject(id) {
  const project = listProjects().find((item) => item.id === id);
  if (!project) throw new Error('Project not found.');
  return project;
}

function updateSettingsFromBody(body) {
  return updateSettings(body || {});
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid request body.');
  }
}

module.exports = { analyze, json, openFolder, openTerminal, readJsonBody, registerProject, routes, runs, runtimeStatus };
