'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IGNORED_DIRECTORIES = new Set([
  '.build',
  '.git',
  'build',
  'Carthage',
  'DerivedData',
  'node_modules',
  'Pods',
]);

function findXcodeProject(directory) {
  const root = path.resolve(String(directory || ''));
  const workspaces = [];
  const projects = [];

  function walk(current, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const target = path.join(current, entry.name);
      if (/\.xcworkspace$/i.test(entry.name)) {
        if (fs.existsSync(path.join(target, 'contents.xcworkspacedata'))) workspaces.push(target);
      } else if (/\.xcodeproj$/i.test(entry.name)) {
        if (fs.existsSync(path.join(target, 'project.pbxproj'))) projects.push(target);
      } else {
        walk(target, depth + 1);
      }
    }
  }

  walk(root, 0);
  const target = workspaces[0] || projects[0] || '';
  if (!target) return null;
  return {
    kind: workspaces.length ? 'workspace' : 'project',
    path: target,
    relative: path.relative(root, target).split(path.sep).join('/'),
  };
}

module.exports = { findXcodeProject };
