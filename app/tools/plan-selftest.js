'use strict';

/**
 * Plan integration self-test.
 *
 * The point of this file is the seam that used to be missing: the compatibility
 * engine has to decide what the plan builder writes. A runtime with a real
 * adapter becomes a setup step. A runtime only a human can install becomes a
 * note with the official page, never a button. A runtime with no build for this
 * platform refuses the step instead of failing halfway.
 *
 *   node tools/plan-selftest.js
 */

const os = require('node:os');
const path = require('node:path');

const { detectStack } = require('../core/detect');
const { buildPlan } = require('../core/plan');
const { adapterIds } = require('../core/runtime-install');
const { forProject } = require('../core/engine/compatibility');

const adapters = adapterIds();
const workspace = path.join(os.tmpdir(), 'guitinstal-plan-selftest');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

function repoFor(name) {
  return {
    owner: 'selftest',
    name,
    fullName: `selftest/${name}`,
    url: `https://github.com/selftest/${name}`,
    cloneUrl: `https://github.com/selftest/${name}.git`,
    description: '',
    stars: 0,
    forks: 0,
    license: '',
    language: '',
    defaultBranch: 'main',
    ownerAvatar: '',
    pushedAt: '',
  };
}

/** Builds a plan the way the server does, from a file list and a runtime list. */
function planFor({ name, files, manifests, available = [] }) {
  const entries = files.map((file) => ({ path: file, size: 128 }));
  const detection = detectStack(entries, manifests);
  const runtimes = ['git', 'node', 'npm', 'python', 'go', 'uv', 'bun', 'java', 'maven', 'cargo', 'php', 'composer', 'bundle', 'dotnet', 'docker', 'make', 'xcode'].map(
    (id) => ({ id, available: available.includes(id) })
  );
  const plan = buildPlan({
    repo: repoFor(name),
    detection,
    settings: { workspace, shallowClone: true },
    runtimes,
  });
  return { plan, detection };
}

const ids = (plan) => plan.steps.map((step) => step.id);
const index = (plan, id) => ids(plan).indexOf(id);

console.log('Plan integration self-test');
console.log('--------------------------');

// 1. A Node project with nothing installed. The compatibility engine should
//    ask for Node itself, not for npm as a second manual step, and the prepare
//    step must land before the step that needs it.
{
  const { plan } = planFor({
    name: 'node-app',
    files: ['package.json', 'server.js'],
    manifests: { 'package.json': JSON.stringify({ name: 'node-app', scripts: { start: 'node server.js' }, dependencies: { express: '4.19.2' } }) },
  });
  const expectPreparable = adapters.includes('node');
  record(
    'a missing Node.js becomes one prepare step when an adapter exists',
    expectPreparable ? ids(plan).includes('prepare-node') : !ids(plan).some((id) => id.startsWith('prepare-')),
    ids(plan).join(' > ')
  );
  record(
    'the Node.js prepare step runs before the dependency step',
    !expectPreparable || index(plan, 'prepare-node') < index(plan, 'install'),
    `${index(plan, 'prepare-node')} vs ${index(plan, 'install')}`
  );
  record(
    'npm is not a separate prepare step',
    !ids(plan).includes('prepare-npm'),
    ids(plan).filter((id) => id.startsWith('prepare-')).join(',') || 'none'
  );
  record(
    'the Node.js plan carries a compatibility verdict',
    plan.preflight.compatibility.verdict === (expectPreparable ? 'installable' : 'guided'),
    plan.preflight.compatibility.verdict
  );
}

// 2. A Node project on a machine that already has Node.js: nothing to prepare.
{
  const { plan } = planFor({
    name: 'node-ready',
    files: ['package.json', 'server.js'],
    manifests: { 'package.json': JSON.stringify({ name: 'node-ready', scripts: { start: 'node server.js' } }) },
    available: ['git', 'node', 'npm'],
  });
  record('an installed runtime needs no prepare step', !ids(plan).some((id) => id.startsWith('prepare-')), ids(plan).join(' > '));
  record('a ready project reports ready', plan.preflight.compatibility.verdict === 'ready', plan.preflight.compatibility.verdict);
  record('the plan is not blocked', plan.blocked === false, String(plan.blocked));
}

// 2b. The same project on a Windows machine with no Git at all: the clone step
// cannot run, so the portable MinGit setup has to come before it.
{
  const { plan } = planFor({
    name: 'node-no-git',
    files: ['package.json', 'server.js'],
    manifests: { 'package.json': JSON.stringify({ name: 'node-no-git', scripts: { start: 'node server.js' } }) },
    available: ['node', 'npm'],
  });
  const order = ids(plan);
  record(
    'a machine without Git gets a MinGit setup step before the clone',
    order[0] === 'prepare-git' && order.indexOf('prepare-git') < order.indexOf('clone'),
    order.join(' > ')
  );
  record('a missing Git does not block the plan', plan.blocked === false, String(plan.blocked));
}

// 3. Maven has no adapter in this build, so Java projects get the official
//    page and no setup step that would not work.
{
  const { plan } = planFor({
    name: 'java-app',
    files: ['pom.xml', 'src/main/java/App.java'],
    manifests: { 'pom.xml': '<project><artifactId>java-app</artifactId><dependency><groupId>org.springframework.boot</groupId></dependency></project>' },
    available: ['java'],
  });
  record('Maven is never a prepare step without an adapter', !ids(plan).includes('prepare-maven'), ids(plan).filter((id) => id.startsWith('prepare-')).join(',') || 'none');
  record('a guided stack reports guided', plan.preflight.compatibility.verdict === 'guided', plan.preflight.compatibility.verdict);
  record(
    'the Java plan names the official Maven page',
    plan.preflight.warnings.join(' ').includes('maven.apache.org'),
    (plan.preflight.warnings.join(' ').match(/https?:\/\/\S+/g) || []).join(' ')
  );
}

// 4. Python already installed: pip and venv are bundled, so the project is
//    ready and still gets its virtual environment step.
{
  const { plan } = planFor({
    name: 'python-app',
    files: ['requirements.txt', 'main.py'],
    manifests: { 'requirements.txt': 'flask==3.0.0\n' },
    available: ['python'],
  });
  record('Python with pip and venv bundled reports ready', plan.preflight.compatibility.verdict === 'ready', plan.preflight.compatibility.verdict);
  record('the Python plan creates a virtual environment', ids(plan).includes('venv'), ids(plan).join(' > '));
}

// 5. A uv project follows uv.lock instead of pip.
{
  const { plan } = planFor({
    name: 'uv-app',
    files: ['uv.lock', 'pyproject.toml', 'main.py'],
    manifests: { 'pyproject.toml': '[project]\nname = "uv-app"\nversion = "1.0.0"\n' },
    available: ['python'],
  });
  const install = plan.steps.find((step) => step.id === 'install');
  record('a uv project installs with uv sync', install?.command === 'uv sync', install?.command || 'no install step');
  record(
    'uv is prepared when it is missing and has an adapter',
    !adapters.includes('uv') || ids(plan).includes('prepare-uv'),
    ids(plan).filter((id) => id.startsWith('prepare-')).join(',') || 'none'
  );
}

// 6. Rust is installed through rustup, and the plan asks for rustup itself.
{
  const { plan } = planFor({
    name: 'rust-app',
    files: ['Cargo.toml', 'src/main.rs'],
    manifests: { 'Cargo.toml': '[package]\nname = "rust-app"\nversion = "0.1.0"\n' },
  });
  record(
    'Rust is prepared through rustup',
    !adapters.includes('rustup') || ids(plan).includes('prepare-rustup'),
    ids(plan).filter((id) => id.startsWith('prepare-')).join(',') || 'none'
  );
  record('the prepare step provides the cargo the plan runs', plan.steps.some((step) => step.id === 'prepare-rustup'), '');
  // The adapter is rustup but the build step requires cargo. Matching only the
  // adapter id put the setup last, so cargo build ran first and failed on a
  // machine the app could have repaired.
  record(
    'the Rust setup runs before the cargo build',
    index(plan, 'prepare-rustup') !== -1 && index(plan, 'prepare-rustup') < index(plan, 'build'),
    ids(plan).join(' > ')
  );
}

// 7. A platform with no build is a refusal, not a missing-tool note.
{
  const blocked = forProject({ stack: 'ruby', platform: 'win32', arch: 'arm64', adapters, available: [] });
  record('a stack with no build for the platform is blocked', blocked.verdict === 'blocked', blocked.verdict);
  record('the blocked verdict carries the reason', blocked.reasons.length > 0, blocked.reasons[0] || '');
  record('a blocked project has runtime details the UI can show', blocked.runtimes.some((item) => item.state === 'blocked'), '');
}

// 8. Every step has the shape the interface and the run engine expect.
{
  const { plan } = planFor({
    name: 'shape',
    files: ['package.json'],
    manifests: { 'package.json': JSON.stringify({ name: 'shape' }) },
  });
  const shaped = plan.steps.every(
    (step) => typeof step.id === 'string' && step.risk?.id && step.status === 'pending' && Number.isInteger(step.index)
  );
  record('every plan step is shaped for the runner', shaped, plan.steps.map((step) => step.id).join(' > '));
  record('the plan carries one compatibility object', Boolean(plan.compatibility?.verdict), plan.compatibility?.verdict || '');
}

// 9. Xcode repositories are saved on every platform, then opened in Xcode on Mac.
{
  const { plan } = planFor({
    name: 'ios-app',
    files: ['ios/GUITinstal.xcworkspace/contents.xcworkspacedata', 'ios/GUITinstal.xcodeproj/project.pbxproj'],
    manifests: {},
  });
  record('an iOS repository is identified as an Apple app', plan.stack.id === 'xcode' && plan.kind === 'ios-app', `${plan.stack.id}:${plan.kind}`);
  record('the shared Xcode workspace is selected', plan.xcodeProjectFile === 'ios/GUITinstal.xcworkspace', plan.xcodeProjectFile);
  record('a missing Xcode does not block saving the repository', !plan.blocked && plan.compatibility.verdict === 'guided', plan.compatibility.verdict);
  record('GUITinstal does not fake an iOS build step', plan.steps.every((step) => !['build', 'launch'].includes(step.id)), ids(plan).join(' > '));
}

const failed = results.filter((item) => !item.ok);
console.log('--------------------------');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const item of failed) console.log(`failed: ${item.name} ${item.detail}`);
  process.exit(1);
}
