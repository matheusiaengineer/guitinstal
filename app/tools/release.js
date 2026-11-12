'use strict'

/**
 * One release command, one audit trail.
 *
 *   npm run release -- "What changed in this version"
 *   npm run release -- "..." --full        also runs the adapter install proofs
 *   npm run release -- "..." --dry-run     checks only, writes nothing
 *
 * The command refuses to continue when the three version sources disagree, when
 * the changelog has no entry for this version, or when a check fails. It never
 * claims a release is published: upload and site deploy are separate, explicit
 * actions, and the report lists them as pending.
 */

const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const appDir = path.join(__dirname, '..')
const repoDir = path.join(appDir, '..')
const siteDir = path.join(repoDir, 'site')
const reportsDir = path.join(repoDir, 'Reports')

const argv = process.argv.slice(2)
const flag = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? '' : argv[at + 1] || ''
}
const has = (name) => argv.includes(`--${name}`)

const dryRun = has('dry-run')
const full = has('full')
const distName = flag('dist') || 'dist-c'
const distDir = path.resolve(appDir, distName)

// Positional words are the release notes; flags and their values are skipped.
const withValue = new Set(['dist', 'base', 'files', 'notes'])
const words = []
for (let i = 0; i < argv.length; i += 1) {
  const word = argv[i]
  if (word.startsWith('--')) {
    if (withValue.has(word.slice(2))) i += 1
    continue
  }
  words.push(word)
}
const notes = (flag('notes') || words.join(' ')).trim()

const results = []
function run (name, command, args, { optional = false } = {}) {
  const started = Date.now()
  let exe = command
  let spawnArgs = args
  let needsShell = false
  if (command === 'npm') {
    const cli = [
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].find((file) => file && fs.existsSync(file))
    if (cli) {
      exe = process.execPath
      spawnArgs = [cli, ...args]
    } else {
      needsShell = true
    }
  }
  const result = spawnSync(exe, spawnArgs, {
    cwd: appDir,
    encoding: 'utf8',
    shell: needsShell,
    timeout: 20 * 60 * 1000,
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  const ok = result.status === 0
  results.push({ name, ok, seconds: Math.round((Date.now() - started) / 1000) })
  console.log(`  ${ok ? 'ok  ' : optional ? 'note' : 'FAIL'} ${name} (${Math.round((Date.now() - started) / 1000)}s)`)
  if (!ok || process.env.RELEASE_VERBOSE) {
    for (const line of output.split(/\r?\n/).slice(-8)) if (line.trim()) console.log(`       ${line}`)
  }
  return { ok, output }
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function fail (message) {
  console.error(`\nrelease stopped: ${message}`)
  process.exit(1)
}

function changedFiles () {
  const result = spawnSync('git', ['status', '--short', '--untracked-files=all'], {
    cwd: repoDir,
    encoding: 'utf8',
  })
  if (result.status !== 0) return 'unavailable'
  const reportPath = `Reports/RELEASE-v${pkg.version}.md`
  const files = String(result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/\\/g, '/'))
    .filter((file) => file !== reportPath)
  return files.length ? files.join(', ') : 'none'
}

const pkg = readJson(path.join(appDir, 'package.json'))
const version = pkg.version
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json version "${version}" is not semver`)

if (!notes) {
  fail('release notes are required: npm run release -- "What changed in this version"')
}

// The changelog is the source of truth humans read; a release without an entry
// is an unaudited release, so it does not get prepared.
const changelogFile = path.join(appDir, 'CHANGELOG.md')
const changelog = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, 'utf8') : ''
if (!changelog.includes(`## [${version}]`)) {
  fail(`CHANGELOG.md has no "## [${version}]" entry. Write it before releasing.`)
}

console.log(`\nGUITinstal ${version}`)
console.log(`notes: ${notes}\n`)

console.log('checks')
run('syntax and catalog', 'npm', ['run', 'check'])
run('engine selftest', 'npm', ['run', 'check:engine'])
run('plan selftest', 'npm', ['run', 'check:plans'])
run('adapter coverage', 'npm', ['run', 'check:adapters'])
if (full) {
  run('adapter install proofs', 'npm', ['run', 'proof:install'], { optional: true })
}

const failed = results.filter((item) => !item.ok)
if (failed.length) {
  fail(`${failed.map((item) => item.name).join(', ')} did not pass`)
}

const base = (flag('base') || `https://github.com/matheusiaengineer/guitinstal/releases/download/v${version}`).replace(/\/$/, '')

// **PORTABLE-ONLY MODE**: if --portable-only is set, only the portable installer is required.
// Otherwise, both setup and portable installers are required (original behavior).
const portableOnly = has('portable-only')
const setupFile = path.join(distDir, `GUITinstal-${version}-Setup-x64.exe`)
const portableFile = path.join(distDir, `GUITinstal-${version}-Portable-x64.exe`)

// Check if portable file exists (required in all modes)
const portableFileExists = fs.existsSync(portableFile)
if (!portableFileExists) {
  fail(
    `the ${version} portable installer is not in ${distName}. Build it first: npm run dist`
  )
}

// If setup file doesn't exist and --portable-only is not set, fail
if (!fs.existsSync(setupFile) && !portableOnly) {
  fail(
    `the ${version} installers are not in ${distName}. Build them first: npm run dist`
  )
}

// If setup file doesn't exist and --portable-only is set, use undefined
const actualSetupFile = fs.existsSync(setupFile) ? setupFile : undefined

// Build assets list: include setup only if it exists (and not portable-only mode)
const assetsFiles = portableFileExists ? (portableOnly ? [portableFile] : [actualSetupFile, portableFile].filter(Boolean)) : [portableFile]

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const assets = assetsFiles.map((file) => ({
  name: path.basename(file),
  bytes: fs.statSync(file).size,
  sha256: sha256(file),
}))

if (dryRun) {
  console.log('\ndry run: nothing written')
  for (const asset of assets) console.log(`  ${asset.name} ${asset.bytes} ${asset.sha256.slice(0, 16)}…`)
  process.exit(0)
}

console.log('\nsite metadata')
const site = run('site/releases.json', 'node', [
  path.join(appDir, 'tools', 'make-site-release.js'),
  '--dist',
  distName,
  '--base',
  base,
  '--notes',
  notes,
])
if (!site.ok) fail('make-site-release.js failed')

const published = (() => {
  try {
    return readJson(path.join(siteDir, 'releases.json')).version
  } catch {
    return ''
  }
})()

// One auditable file per release, written only from what actually ran.
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true })
const reportFile = path.join(reportsDir, `RELEASE-v${version}.md`)
const date = new Date().toISOString().slice(0, 10)
const report = [
  `# Release v${version} — ${date}`,
  '',
  `- Version: ${version}`,
  `- Notes: ${notes}`,
  `- Prepared by: npm run release (tools/release.js)`,
  `- Products: ${process.platform} ${process.arch}, Node ${process.version}`,
  `- Files changed: ${flag('files') || changedFiles()}`,
  '',
  '## Assets',
  '',
  '| File | Bytes | SHA-256 |',
  '| --- | ---: | --- |',
  ...assets.map((asset) => `| ${asset.name} | ${asset.bytes} | \`${asset.sha256}\` |`),
  '',
  '## Checks executed',
  '',
  '| Check | Result | Seconds |',
  '| --- | --- | ---: |',
  ...results.map((item) => `| ${item.name} | ${item.ok ? 'pass' : 'FAIL'} | ${item.seconds} |`),
  '',
  '## Publication state',
  '',
  `- Site metadata version: ${published || 'unknown'}`,
  '- GitHub release upload: **pending** (not performed by this command)',
  '- Asset verification (HTTP 200 + digest): **pending**',
  '- Vercel production deploy: **pending**',
  '',
  '## Not run',
  '',
  full ? '- Nothing was skipped by this command.' : '- Adapter install proofs and the end-to-end smoke test were not run (use --full, or run them separately).',
  '',
].join('\n')
fs.writeFileSync(reportFile, report)

console.log(`\nreport: ${path.relative(repoDir, reportFile)}`)
console.log('\nstill to do before this version is live:')
console.log(`  1. upload ${distName} to the GitHub release v${version}`)
console.log('     node tools/gh-release.js --token-file <file> --tag v' + version + ' --dist ' + distName + ' --publish --verify')
console.log('  2. confirm both asset URLs answer 200 and match the digests above')
console.log('  3. deploy the site: cd ../site && vercel --prod')
console.log('  4. open the site and the app, and check the version and notes match')