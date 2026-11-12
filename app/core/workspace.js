'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { detectStack, MANIFESTS } = require('./detect');
const { parseRepoUrl } = require('./repo-url');
const { findXcodeProject } = require('./xcode');

/**
 * Local repository discovery.
 *
 * GUITinstal used to know only the projects it finished installing: a clone
 * that stopped before the last step lived on disk but not in the library. This
 * module reads the workspace itself, so every Git repository that was
 * downloaded through a link can be listed and adopted by the app.
 */

/** Reads the origin URL straight from .git/config, without running git. */
function remoteOriginUrl(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const section = /\[remote "origin"\]([\s\S]*?)(?=\[|$)/i.exec(text);
    if (!section) return '';
    const url = /^\s*url\s*=\s*(.+)$/m.exec(section[1]);
    return url ? url[1].trim() : '';
  } catch {
    return '';
  }
}

/** Makes every supported remote shape comparable as one https URL. */
function normalizeRemote(value) {
  return String(value || '')
    .trim()
    .replace(/\.git$/i, '')
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com[:/]/i, 'https://github.com/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** True when `target` is inside `root` (and is not `root` itself). */
function insideDir(root, target) {
  const relative = path.relative(path.resolve(String(root || '')), path.resolve(String(target || '')));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function samePath(left, right) {
  const a = path.resolve(String(left || ''));
  const b = path.resolve(String(right || ''));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Stack detection for a folder already on disk. The GitHub-side analysis reads
 * the same manifests from the API; this is its local counterpart, so importing
 * a folder produces the same stack label as downloading it from a link.
 */
function localDetection(dir) {
  try {
    const entries = [];
    const walk = (current, prefix, depth) => {
      for (const item of fs.readdirSync(current, { withFileTypes: true })) {
        if (item.name === 'node_modules' || item.name === '.git' || item.name.startsWith('.venv')) continue;
        const rel = prefix ? `${prefix}/${item.name}` : item.name;
        entries.push({ path: rel, type: item.isDirectory() ? 'tree' : 'blob' });
        if (item.isDirectory() && depth < 2) walk(path.join(current, item.name), rel, depth + 1);
      }
    };
    walk(dir, '', 0);

    const manifests = {};
    for (const name of MANIFESTS) {
      // Root only, exactly like the GitHub-side analysis: a manifest inside a
      // subfolder would build a command that then runs in the wrong directory.
      const hit = entries.find((entry) => entry.path === name);
      if (!hit) continue;
      try {
        const text = fs.readFileSync(path.join(dir, hit.path), 'utf8');
        if (text.length < 40000) manifests[name] = text;
      } catch {
        /* an unreadable manifest is simply not a manifest */
      }
    }
    return detectStack(entries, manifests);
  } catch {
    return null;
  }
}

/** The GitHub coordinates a folder records in .git/config, if any. */
function githubFromRemote(remote) {
  const parsed = parseRepoUrl(
    String(remote || '').replace(/^ssh:\/\/git@github\.com[:/]/i, 'https://github.com/')
  );
  if (!parsed.ok) return null;
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    fullName: `${parsed.owner}/${parsed.repo}`,
    url: parsed.canonicalUrl,
    cloneUrl: parsed.cloneUrl,
  };
}

/**
 * Everything the gallery needs about one folder, without network calls.
 * `detection` is the raw result so the installer can reuse it when adopting.
 */
function describeLocalRepo(dir) {
  const origin = remoteOriginUrl(dir);
  const github = githubFromRemote(origin);
  const fallbackName = path.basename(dir);
  const detection = localDetection(dir);
  const primary = detection?.primary || null;
  const xcodeProject = findXcodeProject(dir);

  return {
    dir,
    name: fallbackName,
    remote: origin,
    owner: github?.owner || '',
    repo: github?.repo || fallbackName,
    fullName: github?.fullName || fallbackName,
    url: github?.url || '',
    cloneUrl: github?.cloneUrl || '',
    stack: primary?.stack || 'unknown',
    stackLabel: primary?.label || 'Generic project',
    confidence: primary?.confidence || 'low',
    markers: primary?.markers || [],
    xcodeProjectFile: xcodeProject?.relative || '',
    detection,
  };
}

/** Immediate child folders that are Git repositories. */
function repositoryDirs(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, '.git')));
}

/**
 * Scans the workspace for downloaded repositories.
 *
 * The workspace itself is the first level. The legacy `.guitinstal-workspace`
 * folder is scanned too, because versions before the gallery kept every clone
 * there and those projects must not vanish from the user's view.
 */
function scanWorkspace(workspace) {
  const root = path.resolve(String(workspace || ''));
  if (!fs.existsSync(root)) return [];

  const dirs = new Set(repositoryDirs(root));
  const legacy = path.join(root, '.guitinstal-workspace');
  if (fs.existsSync(legacy) && insideDir(root, legacy)) {
    for (const dir of repositoryDirs(legacy)) dirs.add(dir);
  }

  return [...dirs]
    .map(describeLocalRepo)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

module.exports = {
  describeLocalRepo,
  insideDir,
  localDetection,
  normalizeRemote,
  remoteOriginUrl,
  samePath,
  scanWorkspace,
};
