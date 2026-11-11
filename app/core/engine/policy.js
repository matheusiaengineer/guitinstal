'use strict';

/**
 * The rules the engine holds itself to.
 *
 * Installing software means running someone else's code on the user's
 * machine, so these rules are not advice, they are the contract between the
 * app and the person using it. Every rule names the file that enforces it and
 * says whether that enforcement is complete.
 *
 * A rule marked "partial" is a rule that holds in some paths and not in
 * others. Writing it down as partial is how it gets finished.
 */

const SECURITY = [
  {
    id: 'command-approval',
    rule: 'No command runs before the person approves it.',
    enforcedBy: 'core/runner.js',
    status: 'implemented',
    detail: 'Every step waits in the approval panel with its exact command line.',
  },
  {
    id: 'argument-arrays',
    rule: 'Commands run as argument arrays, without a shell.',
    enforcedBy: 'core/runner.js, core/plan.js',
    status: 'implemented',
    detail: 'A project name can never become shell syntax, because there is no shell to interpret it.',
  },
  {
    id: 'no-elevation',
    rule: 'GUITinstal never asks for administrator rights.',
    enforcedBy: 'core/runtime-install.js',
    status: 'implemented',
    detail: 'Managed tools install into the user profile. A tool that needs elevation is a guided install.',
  },
  {
    id: 'per-user-tools',
    rule: 'Managed tools live in <userData>/tools and nothing else.',
    enforcedBy: 'core/runtime-install.js, core/tools.js',
    status: 'implemented',
    detail: 'Uninstalling a tool is deleting its own folder. The system PATH is never edited.',
  },
  {
    id: 'download-digest',
    rule: 'A managed download is checked against a digest the vendor publishes.',
    enforcedBy: 'core/runtime-install.js',
    status: 'implemented',
    detail: 'A mismatch fails the step and the file is deleted. Nothing runs on an unverified file.',
  },
  {
    id: 'signature-verification',
    rule: 'A digital signature is verified when the vendor publishes one.',
    enforcedBy: 'core/runtime-install.js',
    status: 'planned',
    detail: 'The catalog records where a signature exists, but the installer verifies the digest only. Authenticode checking is not implemented yet.',
  },
  {
    id: 'credential-storage',
    rule: 'A credential is never written to disk in clear text.',
    enforcedBy: 'core/secret-store.js',
    status: 'implemented',
    detail: 'The GitHub token is sealed with Windows DPAPI for this user only. On other systems it lives in memory for the session and the app says so.',
  },
  {
    id: 'project-secrets',
    rule: 'Project secrets stay in the project folder.',
    enforcedBy: 'core/plan.js',
    status: 'partial',
    detail: 'The .env guidance and the Laravel key generation exist. There is no general secret manager for the other project credentials yet.',
  },
  {
    id: 'no-invented-keys',
    rule: 'GUITinstal never invents an API key or a password.',
    enforcedBy: 'core/plan.js',
    status: 'implemented',
    detail: 'A missing key becomes a question for the person, never a generated value.',
  },
  {
    id: 'local-only-assistant',
    rule: 'Nothing about the machine leaves it without being asked.',
    enforcedBy: 'core/assistant.js',
    status: 'implemented',
    detail: 'The assistant uses local plan, project and log evidence by default. External AI is optional and requires explicit per-request consent.',
  },
  {
    id: 'safe-cancellation',
    rule: 'A cancelled step takes its child processes with it.',
    enforcedBy: 'core/runner.js',
    status: 'implemented',
    detail: 'Windows needs taskkill for the tree; the run stops the whole tree, not only the first process.',
  },
  {
    id: 'safe-uninstall',
    rule: 'Uninstalling removes what GUITstal installed and nothing else.',
    enforcedBy: 'core/runtime-install.js',
    status: 'implemented',
    detail: 'The tool folder is deleted. The project folder and the user data are left alone.',
  },
  {
    id: 'local-api-token',
    rule: 'The local server answers only this machine, and only with the session token.',
    enforcedBy: 'server/main.js',
    status: 'implemented',
    detail: 'The server binds to 127.0.0.1 on a random port, and every request carries the per-session token.',
  },
  {
    id: 'risk-display',
    rule: 'The risk of a step is shown before it is approved.',
    enforcedBy: 'core/plan.js',
    status: 'implemented',
    detail: 'Low, medium or high, with a plain explanation of what the step does.',
  },
  {
    id: 'no-blind-trust',
    rule: 'Being hosted on GitHub is not a reason to trust a repository.',
    enforcedBy: 'core/plan.js, core/runner.js',
    status: 'implemented',
    detail: 'The risk level describes the command, not the source it came from.',
  },
];

const RESOURCES = {
  stepsRunInParallel: false,
  stepsRunInParallelDetail: 'Inside a run the steps are sequential, so two package managers never fight over the same folder.',
  disk: {
    blockUnderMb: 300,
    warnUnderMb: 1024,
    enforcedBy: 'core/disk.js',
    detail: 'An install is refused under 300 MB free and warns under 1024 MB.',
  },
  downloadCache: {
    location: '<userData>/tools/.tmp',
    enforcedBy: 'core/runtime-install.js',
    detail: 'An interrupted or failed download is deleted, so the next attempt never sees a half file.',
  },
  installationDirectory: {
    location: 'the workspace folder, configurable in Settings',
    enforcedBy: 'core/store.js, core/paths.js',
    detail: 'The default is a Repositories folder on the Desktop.',
  },
  cancellation: {
    supported: true,
    enforcedBy: 'core/runner.js',
    detail: 'A running step can be cancelled, and the run can be retried from the failed step.',
  },
  monitoring: {
    disk: true,
    memory: false,
    cpu: false,
    enforcedBy: 'core/disk.js',
    detail: 'Free disk space is checked before an install. Memory and processor use are not measured.',
  },
  neverDeleteUserData: {
    supported: true,
    enforcedBy: 'core/runtime-install.js',
    detail: 'Only a temporary download is removed automatically. Project folders and user data are never deleted.',
  },
};

const PLATFORMS = [
  {
    id: 'win32-x64',
    platform: 'win32',
    arch: 'x64',
    label: 'Windows 10 and 11 (64-bit)',
    status: 'supported',
    installer: 'NSIS setup and a portable build',
    detail: 'The installer and the portable build exist and the test matrix runs on this platform.',
  },
  {
    id: 'win32-arm64',
    platform: 'win32',
    arch: 'arm64',
    label: 'Windows on ARM',
    status: 'planned',
    installer: '',
    detail: 'Several runtimes have no ARM64 build, so this platform is not offered yet.',
  },
  {
    id: 'darwin-x64',
    platform: 'darwin',
    arch: 'x64',
    label: 'macOS (Intel)',
    status: 'planned',
    installer: '',
    detail: 'The app runs from source. No installer and no end-to-end test yet.',
  },
  {
    id: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    label: 'macOS (Apple silicon)',
    status: 'planned',
    installer: '',
    detail: 'The app runs from source. No installer and no end-to-end test yet.',
  },
  {
    id: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    label: 'Linux (64-bit)',
    status: 'planned',
    installer: '',
    detail: 'The app runs from source. The runtime installers are built for Windows only.',
  },
];

/**
 * The rule that keeps the platform list honest: a platform is only called
 * supported when its installer and its end-to-end tests exist.
 */
function platformStatus(platform, arch) {
  const found = PLATFORMS.find((item) => item.platform === platform && item.arch === arch);
  if (!found) return 'planned';
  return found.status;
}

function security() {
  return SECURITY;
}

function resources() {
  return RESOURCES;
}

function platforms() {
  return PLATFORMS;
}

/** The rules that are not fully enforced yet. */
function openRules() {
  return SECURITY.filter((item) => item.status !== 'implemented').map((item) => ({
    id: item.id,
    rule: item.rule,
    status: item.status,
    detail: item.detail,
  }));
}

module.exports = { PLATFORMS, RESOURCES, SECURITY, openRules, platformStatus, platforms, resources, security };
