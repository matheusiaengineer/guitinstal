'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 64 * 1024;
const BLOCKED_PARTS = new Set(['.git', '.guitinstal', 'node_modules', '.ssh', '.aws']);
const BLOCKED_NAMES = new Set(['.env', '.npmrc', '.pypirc', 'credentials', 'secrets']);
const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:ghp_|github_pat_|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})/i,
  /(?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[:=]\s*(['"]?)[^'"\s,;}{]{12,}\1/i,
];

function isInside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function containsSecret(content) {
  return SECRET_CONTENT.some((pattern) => pattern.test(content));
}

function normalizeRelativePath(input) {
  const value = String(input || '').trim();
  const parts = value.split(/[\\/]+/);
  if (
    !value ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes(':') ||
    /[\0-\x1f]/.test(value) ||
    parts.some((part) => {
      const name = part.toLowerCase();
      return part === '..' || BLOCKED_PARTS.has(name) || BLOCKED_NAMES.has(name) || name === '.env' || name.startsWith('.env.');
    }) ||
    /\.(?:pem|key|p12|pfx)$/i.test(value) ||
    /(?:^|[\\/])id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[\\/])/i.test(value)
  ) {
    throw new Error('Choose a normal project file path. Secret files, dependency folders, and paths outside the project are not allowed.');
  }
  return parts.filter(Boolean).join(path.sep);
}

function readProjectFile(projectDir, inputPath) {
  const relativePath = normalizeRelativePath(inputPath);
  const root = fs.realpathSync(projectDir);
  const file = path.resolve(root, relativePath);
  if (!isInside(root, file)) throw new Error('The selected file is outside this project.');

  const details = fs.lstatSync(file);
  if (details.isSymbolicLink() || !details.isFile()) throw new Error('The selected path is not a regular project file.');
  const realFile = fs.realpathSync(file);
  if (!isInside(root, realFile)) throw new Error('The selected file resolves outside this project.');
  if (details.size > MAX_FILE_BYTES) throw new Error('Choose a plain-text file smaller than 64 KiB.');

  const bytes = fs.readFileSync(realFile);
  if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw new Error('The selected file is too large or is not plain text.');
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error('Choose a valid UTF-8 text file.');
  if (containsSecret(content)) {
    throw new Error('This file appears to contain a credential. Remove or replace the secret locally before sending the file to an AI provider.');
  }
  return {
    file: realFile,
    relativePath: relativePath.split(path.sep).join('/'),
    content,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    mode: details.mode & 0o777,
  };
}

function applyProjectFile(projectDir, inputPath, expectedSha256, replacement) {
  if (!/^[a-f0-9]{64}$/i.test(String(expectedSha256 || ''))) {
    throw new Error('The repair preview is invalid. Generate it again before applying.');
  }
  if (typeof replacement !== 'string' || Buffer.byteLength(replacement, 'utf8') > MAX_FILE_BYTES || replacement.includes('\0')) {
    throw new Error('The proposed replacement is too large or is not plain text.');
  }
  if (containsSecret(replacement)) throw new Error('The proposed replacement appears to contain a credential and cannot be applied.');

  const current = readProjectFile(projectDir, inputPath);
  if (current.sha256 !== String(expectedSha256).toLowerCase()) {
    throw new Error('This file changed after the preview. Generate a new proposal before applying it.');
  }
  if (current.content === replacement) throw new Error('The proposal does not change this file.');

  const root = fs.realpathSync(projectDir);
  const appDataDir = path.join(root, '.guitinstal');
  if (fs.existsSync(appDataDir) && fs.lstatSync(appDataDir).isSymbolicLink()) {
    throw new Error('The project log folder is a symbolic link. No repair backup was written.');
  }
  fs.mkdirSync(appDataDir, { recursive: true });
  const realAppDataDir = fs.realpathSync(appDataDir);
  if (!isInside(root, realAppDataDir)) throw new Error('The project log folder resolves outside this project.');
  const backupDir = path.join(realAppDataDir, 'repair-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const realBackupDir = fs.realpathSync(backupDir);
  if (!isInside(root, realBackupDir)) throw new Error('The project backup folder resolves outside this project.');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${stamp}-${crypto.randomBytes(4).toString('hex')}-${path.basename(current.file)}.bak`;
  const backupPath = path.join(realBackupDir, backupName);
  fs.writeFileSync(backupPath, current.content, { encoding: 'utf8', flag: 'wx', mode: current.mode });

  const tempPath = path.join(path.dirname(current.file), `.${path.basename(current.file)}.guitinstal-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tempPath, replacement, { encoding: 'utf8', flag: 'wx', mode: current.mode });
    fs.chmodSync(tempPath, current.mode);
    fs.renameSync(tempPath, current.file);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      /* preserve the original write error */
    }
    throw new Error(`Could not apply the file repair: ${error.message}`);
  }

  return {
    relativePath: current.relativePath,
    backupPath: path.relative(root, backupPath).split(path.sep).join('/'),
    sha256: crypto.createHash('sha256').update(replacement).digest('hex'),
  };
}

module.exports = { applyProjectFile, readProjectFile };
