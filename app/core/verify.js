'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { currentBranch, isGitRepo, localHead } = require('./git');
const { findXcodeProject } = require('./xcode');

/**
 * Proves an installation actually produced files.
 *
 * A run reporting "done" only means every command exited with 0. That is not
 * the same as the project being on disk, so the app checks the folder itself
 * before it tells the user the install worked.
 */

const MANIFESTS = ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'composer.json', 'Gemfile', 'Cargo.toml', 'pom.xml', 'build.gradle', 'Dockerfile'];
const FILE_CAP = 50000;
// .git holds repository objects and .guitinstal holds our own logs: neither is
// a project file, so counting them would let the app claim files it did not
// install. node_modules and .venv stay counted because they are the proof that
// a dependency step put something there.
const NOT_PROJECT = new Set(['.git', '.guitinstal']);

/** Walks a folder once and returns how many project files it holds and their size. */
function survey(dir, cap = FILE_CAP) {
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_PROJECT.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files >= cap) {
        truncated = true;
        continue;
      }
      files += 1;
      try {
        bytes += fs.statSync(full).size;
      } catch {
        /* a file that vanished mid-walk is not worth failing for */
      }
    }
  }
  return { files, bytes, truncated };
}

async function verifyInstall(directory) {
  const result = {
    ok: false,
    directory,
    exists: false,
    files: 0,
    truncated: false,
    bytes: 0,
    isGit: false,
    commit: '',
    branch: '',
    manifest: '',
    problems: [],
    checkedAt: new Date().toISOString(),
  };

  let stat = null;
  try {
    stat = fs.statSync(directory);
  } catch {
    result.problems.push('The folder does not exist.');
    return result;
  }
  if (!stat.isDirectory()) {
    result.problems.push('The target path exists but is not a folder.');
    return result;
  }
  result.exists = true;

  const surveyed = survey(directory);
  result.files = surveyed.files;
  result.bytes = surveyed.bytes;
  result.truncated = surveyed.truncated;

  if (!result.files) result.problems.push('The folder is empty.');

  if (await isGitRepo(directory)) {
    result.isGit = true;
    result.commit = (await localHead(directory)).slice(0, 7);
    result.branch = await currentBranch(directory);
  } else if (result.files) {
    result.problems.push('The folder is not a Git repository.');
  }

  for (const name of MANIFESTS) {
    if (fs.existsSync(path.join(directory, name))) {
      result.manifest = name;
      break;
    }
  }

  result.ok = result.exists && result.files > 0 && result.problems.length === 0;
  return result;
}

/**
 * Where a stack keeps the proof that its dependencies were really installed.
 * A clone alone satisfies none of these, so "downloaded" can never be reported
 * as "installed".
 */
const DEPENDENCY_PATHS = {
  node: ['node_modules'],
  python: ['.venv', 'venv'],
  php: ['vendor'],
  ruby: ['vendor/bundle', '.bundle'],
  rust: ['target'],
  java: ['target', 'build'],
  dotnet: ['obj', 'bin'],
  // Go and Docker keep their dependencies outside the project folder, so
  // there is nothing here to check and the state is not lowered for it.
  go: [],
  docker: [],
  make: [],
};

/**
 * Project-specific verification.
 *
 * A download finishing, or every command exiting 0, is not the same claim as
 * "this project is installed". This asks the folder itself: the files, the Git
 * revision, the manifest, the dependency folder for this stack, whether a
 * required .env is still missing, and whether a launch profile exists.
 *
 * The state it returns is the one the interface shows:
 *   failed             - there is nothing on disk
 *   needs-configuration - installed, but the project asks for settings first
 *   installed          - files and dependencies are there, a check is still open
 *   verified           - every check that applies passed
 *   launchable         - verified, and there is a start command behind it
 *
 * @param {string} directory
 * @param {{stack?: string, hasLaunch?: boolean}} context
 */
async function verifyProject(directory, context = {}) {
  const base = await verifyInstall(directory);
  const stack = String(context.stack || '');
  const checks = [];
  const add = (id, ok, detail, skipped = false) =>
    checks.push({ id, ok: Boolean(ok), skipped: Boolean(skipped), detail });

  add('repository', base.exists && base.files > 0, base.exists ? `${base.files} project files` : 'the folder does not exist');
  add('git', base.isGit, base.isGit ? `commit ${base.commit}` : 'not a Git repository');
  const xcodeProject = stack === 'xcode' ? findXcodeProject(directory) : null;
  add('manifest', Boolean(base.manifest || xcodeProject), base.manifest || xcodeProject?.relative || 'no known manifest in the folder');

  const paths = DEPENDENCY_PATHS[stack];
  if (paths === undefined) {
    add('dependencies', true, 'this project type has no dependency folder GUITinstal can check', true);
  } else if (!paths.length) {
    add('dependencies', true, 'dependencies for this stack live outside the project folder', true);
  } else {
    const found = paths.find((name) => fs.existsSync(path.join(directory, name)));
    add('dependencies', Boolean(found), found || `none of ${paths.join(', ')} is present`);
  }

  const examples = ['.env.example', '.env.sample', '.env.template'];
  const hasExample = examples.some((name) => fs.existsSync(path.join(directory, name)));
  const hasEnv = fs.existsSync(path.join(directory, '.env'));
  if (hasExample && !hasEnv) {
    add('environment', false, 'the project ships an .env example and has no .env yet');
  } else {
    add('environment', true, hasEnv ? '.env is present' : 'this project needs no .env', !hasExample && !hasEnv);
  }

  const hasLaunch = context.hasLaunch === undefined ? true : Boolean(context.hasLaunch);
  add('launch-profile', hasLaunch, hasLaunch ? 'a start command is recorded' : 'no start command was detected');

  const open = checks.filter((item) => !item.ok && !item.skipped);
  const needsConfig = checks.some((item) => item.id === 'environment' && !item.ok);
  let state = 'installed';
  if (!base.exists || !base.files) state = 'failed';
  else if (needsConfig) state = 'needs-configuration';
  else if (open.length) state = 'installed';
  else if (hasLaunch) state = 'launchable';
  else state = 'verified';

  return { ...base, directory, stack, state, checks, open: open.map((item) => item.detail) };
}

module.exports = { DEPENDENCY_PATHS, survey, verifyInstall, verifyProject };
