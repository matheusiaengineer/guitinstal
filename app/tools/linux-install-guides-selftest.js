'use strict';

const assert = require('node:assert/strict');
const { linuxInstallCommands } = require('../core/linux-install-guides');

const guides = linuxInstallCommands(['node', 'npm', 'python', 'pip', 'venv', 'git']);
assert.deepEqual(guides.map((item) => item.manager), ['apt', 'dnf', 'pacman']);
assert.equal(
  guides[0].command,
  'sudo apt-get update && sudo apt-get install -y nodejs npm python3 python3-pip python3-venv git'
);
assert.deepEqual(guides[0].uncovered, []);

const partial = linuxInstallCommands(['node', 'docker']);
assert.equal(partial.length, 3);
assert.deepEqual(partial[0].covered, ['node']);
assert.deepEqual(partial[0].uncovered, ['docker']);
assert.deepEqual(linuxInstallCommands(['not-a-runtime; touch /tmp/nope']), []);

console.log('Linux install guide self-test: 3/3 checks passed');
