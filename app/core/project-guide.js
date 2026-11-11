'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { localDetection } = require('./workspace');

const README_NAMES = ['README.md', 'README', 'README.txt', 'README.rst'];
const MAX_README_BYTES = 48 * 1024;
const MAX_GUIDE_CHARS = 6000;
const RUN_SECTION = /\b(quick start|get started|getting started|install(?:ation)?|usage|run|start|develop(?:ment)?|local setup)\b/i;

function redact(text) {
  return String(text || '')
    .replace(/\b(?:ghp_|github_pat_|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})[A-Za-z0-9._-]*/gi, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[:=]\s*["']?)[^\s"'`,}]+/gi, '$1[redacted]');
}

function runInstructions(text) {
  const lines = String(text || '').split(/\r?\n/);
  const selected = [];
  let includeSection = false;

  for (const line of lines) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      includeSection = RUN_SECTION.test(heading[1]);
      if (includeSection) selected.push(line);
    } else if (includeSection) {
      selected.push(line);
    }
    if (selected.join('\n').length >= MAX_GUIDE_CHARS) break;
  }

  const excerpt = selected.length ? selected.join('\n') : lines.slice(0, 20).join('\n');
  return redact(excerpt).slice(0, MAX_GUIDE_CHARS).trim();
}

function readmeFor(projectDir) {
  for (const name of README_NAMES) {
    const file = path.join(projectDir, name);
    let details;
    try {
      details = fs.lstatSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`Could not inspect ${name}: ${error.message}`);
    }
    if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_README_BYTES) continue;

    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch (error) {
      throw new Error(`Could not read ${name}: ${error.message}`);
    }
    if (bytes.length > MAX_README_BYTES || bytes.includes(0)) continue;
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) continue;
    return { file: name, instructions: runInstructions(content) };
  }
  return { file: '', instructions: '' };
}

function projectGuide(projectDir) {
  const readme = readmeFor(projectDir);
  const detection = localDetection(projectDir);
  const primary = detection?.primary || null;
  const scripts = primary?.scripts || {};
  const relevantScripts = Object.fromEntries(
    Object.entries(scripts)
      .filter(([name]) => /^(start|dev|serve|preview|run)$/i.test(name))
      .slice(0, 5)
      .map(([name, command]) => [name, String(command).slice(0, 180)])
  );

  return {
    stack: primary?.label || '',
    markers: (primary?.markers || []).slice(0, 8),
    runtimes: (primary?.runtimes || []).slice(0, 8),
    entry: primary?.entry || '',
    packageManager: primary?.packageManager || '',
    scripts: relevantScripts,
    readmeFile: readme.file,
    readmeInstructions: readme.instructions,
  };
}

module.exports = { projectGuide, runInstructions };
