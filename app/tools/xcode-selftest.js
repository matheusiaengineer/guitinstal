'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findXcodeProject } = require('../core/xcode');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guitinstal-xcode-'));
try {
  const projectFile = path.join(root, 'ios', 'App.xcodeproj');
  fs.mkdirSync(projectFile, { recursive: true });
  fs.writeFileSync(path.join(projectFile, 'project.pbxproj'), '');
  assert.deepEqual(findXcodeProject(root), {
    kind: 'project',
    path: projectFile,
    relative: 'ios/App.xcodeproj',
  });

  const workspace = path.join(root, 'ios', 'App.xcworkspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'contents.xcworkspacedata'), '');
  assert.equal(findXcodeProject(root).kind, 'workspace');

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(projectFile, { recursive: true, force: true });
  assert.equal(findXcodeProject(root), null);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Xcode project self-test: 3/3 checks passed');
