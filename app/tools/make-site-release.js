'use strict';

/**
 * Builds site/releases.json from the files electron-builder left in app/dist.
 *
 *   node tools/make-site-release.js --base https://github.com/you/guitinstal/releases/download/v1.0.0
 *
 * The base URL is the host that serves the binaries. Vercel's Hobby plan caps a
 * deploy upload at 100 MB, so a 121 MB installer cannot ship inside the site.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const argv = process.argv.slice(2);
const argFlag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? '' : argv[i + 1] || '';
};

const appDir = path.join(__dirname, '..');
const siteDir = path.join(appDir, '..', 'site');
// electron-builder writes to a copy on C: when the Z: drive locks the binaries.
const distDir = path.resolve(argFlag('dist') || path.join(appDir, 'dist'));

const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));

let previous = {};
try {
  previous = JSON.parse(fs.readFileSync(path.join(siteDir, 'releases.json'), 'utf8'));
} catch {}

// Social URLs survive a rebuild: pass --github/--discord/--x/--youtube once.
const link = (name) => argFlag(name) || previous.links?.[name] || '';
const base =
  argFlag('base').replace(/\/$/, '') ||
  `https://github.com/matheusiaengineer/guitinstal/releases/download/v${pkg.version}`;

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function describe(name, kind) {
  const file = path.join(distDir, name);
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  return {
    kind,
    name,
    url: base ? `${base}/${name}` : '',
    size: stat.size,
    sizeLabel: `${(stat.size / 1024 / 1024).toFixed(1)} MB`,
    sha256: sha256(file),
    builtAt: stat.mtime.toISOString(),
  };
}

const setup = describe(`GUITinstal-${pkg.version}-Setup-x64.exe`, 'setup');
const portable = describe(`GUITinstal-${pkg.version}-Portable-x64.exe`, 'portable');
const windows = [setup, portable].filter(Boolean);
const macos = [describe(`GUITinstal-${pkg.version}-mac-universal.dmg`, 'universal')].filter(Boolean);
const linux = [describe(`GUITinstal-${pkg.version}-linux-x64.AppImage`, 'appimage')].filter(Boolean);
const sourceFiles = (platform) =>
  (previous.platforms?.[platform]?.files || []).filter(
    (file) => file.kind === 'source' && file.source === 'direct'
  );
const macosFiles = macos.length ? macos.map((file) => ({ ...file, recommended: true })) : sourceFiles('macos');
const linuxFiles = linux.length ? linux.map((file) => ({ ...file, recommended: true })) : sourceFiles('linux');
const builtFiles = [...windows, ...macos, ...linux];

const manifest = {
  version: pkg.version,
  releasedAt: (builtFiles[0]?.builtAt || new Date().toISOString()).slice(0, 10),
  releaseNotes: builtFiles.length
    ? argFlag('notes') || previous.releaseNotes || 'Desktop release: analyze a repository, review the plan, approve each command.'
    : 'No installer published yet.',
  installGuide: 'download.html',
  links: {
    github: link('github'),
    discord: link('discord'),
    x: link('x'),
    youtube: link('youtube'),
  },
  platforms: {
    windows: {
      label: 'Windows 10 / 11 (64-bit)',
      status: windows.length ? 'available' : 'pending',
      requirement: '450 MB free disk. Node.js, Git and Python are optional but unlock more stacks.',
      files: windows.map((file, index) => ({ ...file, recommended: index === 0 })),
    },
    macos: {
      label: 'macOS (Intel and Apple silicon)',
      status: macos.length ? 'available' : 'pending',
      requirement: 'Universal DMG. macOS may warn that the app is from an unidentified developer.',
      files: macosFiles,
    },
    linux: {
      label: 'Linux (x86_64)',
      status: linux.length ? 'available' : 'pending',
      requirement: 'AppImage. FUSE 2 support may be required by your distribution.',
      files: linuxFiles,
    },
  },
};

fs.mkdirSync(siteDir, { recursive: true });
fs.writeFileSync(path.join(siteDir, 'releases.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log('site/releases.json written');
for (const file of builtFiles) console.log(`  ${file.name}  ${file.sizeLabel}  sha256 ${file.sha256.slice(0, 16)}…  ${file.url}`);
