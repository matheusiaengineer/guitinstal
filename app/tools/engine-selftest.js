'use strict';

/**
 * Self-test for the engine configuration.
 *
 * The configuration is data with rules, so it can be tested. This file feeds
 * known repositories into the project classifier, the compatibility engine and
 * the catalog validator, and says which expectations held.
 *
 * The fixtures describe shapes, not real repositories: what matters is that a
 * desktop application is never reported as a web application, and that a
 * repository GUITinstal cannot classify produces a question instead of a
 * guess.
 *
 * Run it with: node tools/engine-selftest.js
 */

const { detectStack } = require('../core/detect');
const { classify } = require('../core/engine/project-type');
const { check: runtimeVerdict, forStack } = require('../core/engine/compatibility');
const { resolve } = require('../core/engine/requirements');
const { validate } = require('../core/engine/catalog');

const FIXTURES = [
  {
    name: 'a React application',
    files: ['package.json', 'src/index.jsx', 'public/index.html'],
    manifests: {
      'package.json': JSON.stringify({
        name: 'demo-web',
        scripts: { dev: 'next dev', start: 'next start', build: 'next build' },
        dependencies: { react: '18.2.0', next: '14.0.0' },
      }),
    },
    repo: { name: 'demo-web' },
    expect: { type: 'web-application', launch: 'open-in-browser' },
  },
  {
    name: 'a Node command line tool',
    files: ['package.json', 'bin/tool.js', 'README.md'],
    manifests: {
      'package.json': JSON.stringify({ name: 'tool', version: '1.0.0', bin: { tool: 'bin/tool.js' } }),
    },
    repo: { name: 'tool' },
    expect: { type: 'cli-tool', launch: 'run-command' },
  },
  {
    name: 'an iOS project with an Xcode workspace',
    files: ['ios/GUITinstal.xcworkspace/contents.xcworkspacedata', 'ios/GUITinstal.xcodeproj/project.pbxproj'],
    manifests: {},
    repo: { name: 'guitinstal-ios' },
    expect: { type: 'apple-application', launch: 'open-in-xcode', stack: 'xcode' },
  },
  {
    name: 'a Django application',
    files: ['manage.py', 'requirements.txt', 'demo/settings.py'],
    manifests: { 'requirements.txt': 'Django==5.0.6\nrequests==2.32.0\n' },
    repo: { name: 'demo-site' },
    expect: { type: 'web-application', launch: 'open-in-browser' },
  },
  {
    name: 'a FastAPI service',
    files: ['requirements.txt', 'app/main.py'],
    manifests: { 'requirements.txt': 'fastapi==0.110.0\nuvicorn==0.29.0\n' },
    repo: { name: 'demo-api' },
    expect: { type: 'backend-service', launch: 'start-stop' },
  },
  {
    name: 'a Python library',
    files: ['pyproject.toml', 'src/demo/__init__.py'],
    manifests: { 'pyproject.toml': '[project]\nname = "demo-lib"\nversion = "1.0.0"\n' },
    repo: { name: 'demo-lib' },
    expect: { type: 'library', launch: 'open-project' },
  },
  {
    name: 'an Electron application',
    files: ['package.json', 'main.js', 'index.html'],
    manifests: {
      'package.json': JSON.stringify({
        name: 'demo-desktop',
        main: 'main.js',
        dependencies: { electron: '30.0.0' },
      }),
    },
    repo: { name: 'demo-desktop' },
    expect: { type: 'desktop-application', launch: 'run-app' },
  },
  {
    name: 'a compose file with two services',
    files: ['docker-compose.yml', 'api/main.py', 'web/index.html'],
    manifests: {
      'docker-compose.yml': 'services:\n  api:\n    image: python:3.12\n  web:\n    image: nginx:alpine\n',
    },
    repo: { name: 'demo-stack' },
    expect: { type: 'multi-service-application', launch: 'start-stop' },
  },
  {
    name: 'an AI skill',
    files: ['SKILL.md', 'README.md'],
    manifests: {},
    repo: { name: 'demo-skill' },
    expect: { type: 'ai-skill', launch: 'install-in-host' },
  },
  {
    name: 'an AI application',
    files: ['package.json', 'server.js'],
    manifests: {
      'package.json': JSON.stringify({
        name: 'demo-bot',
        scripts: { start: 'node server.js' },
        dependencies: { openai: '4.28.0', express: '4.19.2' },
      }),
    },
    repo: { name: 'demo-bot' },
    expect: { type: 'ai-application' },
  },
  {
    name: 'a repository with nothing recognizable',
    files: ['README.md', 'notes.txt'],
    manifests: {},
    repo: { name: 'mystery' },
    expect: { type: 'unknown', question: true },
  },
];

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${name}${detail ? ` - ${detail}` : ''}`);
}

console.log('Engine self-test');
console.log('-----------------');
require('./xcode-selftest');

// 1. The catalog must be consistent with itself.
const catalogResult = validate();
record(
  'the catalog validates',
  catalogResult.ok,
  catalogResult.ok ? '' : JSON.stringify(catalogResult.problems)
);

// 2. Every fixture must land in the expected category.
for (const fixture of FIXTURES) {
  const entries = fixture.files.map((path) => ({ path, size: 128 }));
  const detection = detectStack(entries, fixture.manifests);
  const result = classify({ entries, manifests: fixture.manifests, detection, repo: fixture.repo });
  if (fixture.expect.stack) {
    record(
      `${fixture.name} is recognized as ${fixture.expect.stack}`,
      detection.primary?.stack === fixture.expect.stack,
      detection.primary?.stack === fixture.expect.stack ? '' : `got "${detection.primary?.stack || 'unknown'}"`
    );
  }

  const typeOk = result.type === fixture.expect.type;
  record(
    `${fixture.name} is classified as ${fixture.expect.type}`,
    typeOk,
    typeOk ? '' : `got "${result.type}" (${result.markers.join(', ')})`
  );

  if (fixture.expect.launch) {
    record(
      `${fixture.name} launches with ${fixture.expect.launch}`,
      result.launch.model === fixture.expect.launch,
      result.launch.model === fixture.expect.launch ? '' : `got "${result.launch.model}"`
    );
  }

  if (fixture.expect.question) {
    record(
      `${fixture.name} asks a question instead of guessing`,
      Boolean(result.question),
      result.question ? '' : 'the question is empty'
    );
  }
}

// 3. A runtime that needs elevation has to stay a guided install.
const blocked = runtimeVerdict('docker', { platform: 'win32', arch: 'x64' });
record(
  'docker is guided on Windows, never installed silently',
  blocked.verdict === 'guided',
  `verdict "${blocked.verdict}"`
);
record(
  'docker states that it needs administrator rights',
  blocked.requiresAdmin === true,
  `requiresAdmin ${blocked.requiresAdmin}`
);
const xcodeWin = runtimeVerdict('xcode', { platform: 'win32', arch: 'x64', adapters: [] });
record('Xcode stays guided on Windows so projects can still be saved', xcodeWin.verdict === 'guided', xcodeWin.verdict);
const xcodeMac = runtimeVerdict('xcode', { platform: 'darwin', arch: 'arm64', adapters: [] });
record('Xcode is guided on macOS until Apple installs it', xcodeMac.verdict === 'guided', xcodeMac.verdict);
const xcodeReady = forStack('xcode', { platform: 'darwin', arch: 'arm64', available: ['xcode'], adapters: [] });
record('an installed Xcode is ready on Apple Silicon', xcodeReady.verdict === 'supported', xcodeReady.verdict);

// 4. A managed runtime has to be installable and has to publish a digest.
const php = runtimeVerdict('php', { platform: 'win32', arch: 'x64' });
record('php is installable on Windows x64', php.verdict === 'installable', `verdict "${php.verdict}"`);

// 5. The requirements of a stack have to come back in a usable order.
const requirements = resolve('php', ['php']);
record(
  'the PHP stack requires PHP and Composer',
  requirements.requirements.map((item) => item.id).join(',') === 'php,composer',
  requirements.requirements.map((item) => item.id).join(',')
);
record(
  'an installed runtime is ready and a missing one is prepared',
  requirements.requirements[0].action === 'ready' && requirements.requirements[1].action === 'prepare',
  requirements.requirements.map((item) => `${item.id}:${item.action}`).join(',')
);

// 6. The stack compatibility has to agree with the catalog.
const stackCompatibility = forStack('php', { platform: 'win32', arch: 'x64' });
record(
  'the PHP stack is supported on Windows x64',
  stackCompatibility.verdict === 'supported',
  `verdict "${stackCompatibility.verdict}"`
);

// 7. A package manager is an alternative, not a requirement.
const nodeRequirements = resolve('node', []);
record(
  'a Node project does not need three package managers at once',
  nodeRequirements.requirements.map((item) => item.id).join(',') === 'node,npm',
  nodeRequirements.requirements.map((item) => item.id).join(',')
);
const pnpmRequirements = resolve('node', [], { packageManager: 'pnpm' });
record(
  'the package manager the project uses is the one that is required',
  pnpmRequirements.requirements.map((item) => item.id).join(',') === 'node,npm,pnpm',
  pnpmRequirements.requirements.map((item) => item.id).join(',')
);

const failed = results.filter((item) => !item.ok);
console.log('-----------------');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('');
  for (const item of failed) console.log(`failed: ${item.name} ${item.detail}`);
  process.exit(1);
}
