'use strict';

const { isSafeScriptName } = require('./repo-url');

/**
 * Detects the technology stack of a repository from its file tree plus the
 * content of the key manifests. Pure function: no network, no filesystem.
 */

const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'pom.xml',
  'composer.json',
  'Cargo.toml',
  'docker-compose.yml',
  'compose.yaml',
];

function has(entries, path) {
  return entries.some((entry) => entry.path === path);
}

function hasAny(entries, list) {
  return list.some((path) => has(entries, path));
}

function findFirst(entries, candidates) {
  return candidates.find((candidate) => has(entries, candidate)) || '';
}

function parseJson(content) {
  if (!content) return null;
  try {
    const value = JSON.parse(content);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function detectNode(entries, manifests) {
  const pkg = parseJson(manifests['package.json']);
  if (!pkg) return null;

  const scripts = {};
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    if (isSafeScriptName(name)) scripts[name] = String(command).slice(0, 200);
  }

  const entry =
    (typeof pkg.main === 'string' && pkg.main) ||
    findFirst(entries, ['index.js', 'src/index.js', 'app.js', 'src/app.js', 'server.js', 'src/server.js']) ||
    '';

  const hasLock = has(entries, 'package-lock.json');
  const hasYarn = has(entries, 'yarn.lock');
  const hasPnpm = has(entries, 'pnpm-lock.yaml');
  const hasTests = hasAny(entries, ['test', 'tests', '__tests__']) || Boolean(scripts.test);

  return {
    stack: 'node',
    label: 'Node.js',
    confidence: 'high',
    markers: [hasLock ? 'package-lock.json' : 'package.json', ...(hasTests ? ['test suite'] : [])],
    runtimes: ['node', 'npm'],
    scripts,
    entry,
    packageManager: hasPnpm ? 'pnpm' : hasYarn ? 'yarn' : 'npm',
    dependencyCount: Object.keys(pkg.dependencies || {}).length,
    hasBin: Boolean(pkg.bin),
    hasTests,
    hasLock,
    requiresNode: pkg.engines?.node || '',
  };
}

function detectPython(entries, manifests) {
  if (!hasAny(entries, ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'])) return null;

  const requirements = manifests['requirements.txt'] || '';
  const pyproject = manifests['pyproject.toml'] || '';
  const all = `${requirements}\n${pyproject}\n${manifests['setup.py'] || ''}`.toLowerCase();

  const frameworks = [];
  if (all.includes('streamlit')) frameworks.push('streamlit');
  if (all.includes('fastapi')) frameworks.push('fastapi');
  if (all.includes('uvicorn')) frameworks.push('uvicorn');
  if (all.includes('flask')) frameworks.push('flask');
  if (all.includes('django')) frameworks.push('django');

  const entry = findFirst(entries, ['main.py', 'app.py', 'run.py', 'src/main.py', 'src/app.py', 'manage.py']);

  return {
    stack: 'python',
    label: 'Python',
    confidence: 'high',
    markers: [has(entries, 'requirements.txt') ? 'requirements.txt' : 'pyproject.toml', ...frameworks.slice(0, 2)],
    runtimes: ['python'],
    frameworks,
    entry,
    // The package manager is a choice the project already made: its lockfile.
    // The plan follows it instead of installing three managers at once.
    packageManager: has(entries, 'uv.lock') ? 'uv' : has(entries, 'poetry.lock') ? 'poetry' : 'pip',
    hasTests: hasAny(entries, ['tests', 'test']),
    requirements: requirements
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('-'))
      .slice(0, 40),
  };
}

function detectDocker(entries) {
  const compose = hasAny(entries, ['docker-compose.yml', 'compose.yaml', 'compose.yml']);
  const dockerfile = has(entries, 'Dockerfile');
  if (!compose && !dockerfile) return null;
  return {
    stack: 'docker',
    label: 'Docker',
    confidence: compose ? 'high' : 'medium',
    markers: [compose ? 'compose file' : 'Dockerfile'],
    runtimes: ['docker'],
    compose,
    dockerfile,
    hasTests: false,
  };
}

function detectGo(entries) {
  if (!has(entries, 'go.mod')) return null;
  return {
    stack: 'go',
    label: 'Go',
    confidence: 'high',
    markers: ['go.mod'],
    runtimes: ['go'],
    entry: findFirst(entries, ['main.go', 'cmd/main.go']),
    hasTests: hasAny(entries, ['*_test.go']),
  };
}

function detectRust(entries) {
  if (!has(entries, 'Cargo.toml')) return null;
  return {
    stack: 'rust',
    label: 'Rust',
    confidence: 'high',
    markers: ['Cargo.toml'],
    runtimes: ['cargo'],
    entry: findFirst(entries, ['src/main.rs']),
    hasTests: has(entries, 'tests') || has(entries, 'src/tests'),
  };
}

function detectJava(entries, manifests) {
  const maven = has(entries, 'pom.xml');
  const gradle = hasAny(entries, ['build.gradle', 'build.gradle.kts']);
  if (!maven && !gradle) return null;
  const pom = manifests['pom.xml'] || '';
  const spring = /spring-boot/i.test(pom);
  let artifact = '';
  const artifactMatch = pom.match(/<artifactId>([^<]+)<\/artifactId>/);
  if (artifactMatch) artifact = artifactMatch[1];
  return {
    stack: 'java',
    label: maven ? 'Java (Maven)' : 'Java (Gradle)',
    confidence: 'high',
    markers: [maven ? 'pom.xml' : 'build.gradle', ...(spring ? ['Spring Boot'] : [])],
    runtimes: maven ? ['maven'] : ['gradle'],
    framework: spring ? 'spring' : '',
    artifact,
    hasTests: has(entries, 'src/test'),
  };
}

function detectPhp(entries, manifests = {}) {
  if (!has(entries, 'composer.json')) return null;
  const composer = parseJson(manifests['composer.json']);
  const require = composer?.require || {};
  // Laravel publishes an "artisan" file and requires laravel/framework. Either
  // marker is enough: the install needs .env, APP_KEY and migrations, while a
  // plain composer library does not.
  const laravel = Boolean(require['laravel/framework']) || has(entries, 'artisan');
  return {
    stack: 'php',
    label: 'PHP',
    confidence: 'high',
    markers: ['composer.json', ...(laravel ? ['artisan'] : [])],
    runtimes: ['php', 'composer'],
    entry: findFirst(entries, ['public/index.php', 'index.php']),
    laravel,
    composerRequires: Object.keys(require),
    hasTests: has(entries, 'tests'),
  };
}

function detectRuby(entries) {
  if (!has(entries, 'Gemfile')) return null;
  return {
    stack: 'ruby',
    label: 'Ruby',
    confidence: 'high',
    markers: ['Gemfile'],
    runtimes: ['bundle'],
    entry: findFirst(entries, ['config.ru', 'app.rb', 'bin/rails']),
    rails: has(entries, 'config/application.rb'),
    hasTests: has(entries, 'spec') || has(entries, 'test'),
  };
}

function detectDotnet(entries) {
  const projects = entries.filter((entry) => /\.(csproj|fsproj|vbproj|sln)$/i.test(entry.path));
  if (!projects.length) return null;

  // A solution or project at the repository root is the application itself.
  // When every project file sits in a subfolder and more than one exists, the
  // repository is a collection of samples, not one .NET app: claiming "dotnet
  // restore" would install nothing and fail with MSB1003.
  const atRoot = projects.filter((entry) => !entry.path.includes('/'));
  const anchor = atRoot[0] || (projects.length === 1 ? projects[0] : null);
  if (!anchor) return null;

  return {
    stack: 'dotnet',
    label: '.NET',
    confidence: atRoot.length ? 'high' : 'medium',
    markers: [anchor.path.split('/').pop()],
    runtimes: ['dotnet'],
    projectFile: anchor.path.includes('/') ? anchor.path : '',
    // packages.config is the old NuGet format: "dotnet restore" reports
    // "Nothing to do" for it and "dotnet build" then fails with a message that
    // tells the user to enable Package Restore. Only MSBuild (from Visual
    // Studio Build Tools) or nuget.exe can install those packages.
    packagesConfig: entries.some((entry) => /(^|\/)packages\.config$/i.test(entry.path)),
    hasTests: projects.some((entry) => /test/i.test(entry.path)),
  };
}

function detectMake(entries) {
  if (!has(entries, 'Makefile') && !has(entries, 'makefile')) return null;
  return {
    stack: 'make',
    label: 'Make',
    confidence: 'medium',
    markers: ['Makefile'],
    runtimes: ['make'],
    hasTests: has(entries, 'Makefile'),
  };
}

function detectXcode(entries) {
  const paths = entries.map((entry) => entry.path);
  const workspaces = paths
    .filter((file) => /\.xcworkspace\/contents\.xcworkspacedata$/i.test(file))
    .map((file) => file.slice(0, file.toLowerCase().indexOf('.xcworkspace/') + '.xcworkspace'.length))
    .sort();
  const projects = paths
    .filter((file) => /\.xcodeproj\/project\.pbxproj$/i.test(file))
    .map((file) => file.slice(0, file.toLowerCase().lastIndexOf('.xcodeproj') + '.xcodeproj'.length))
    .sort();
  const projectFile = workspaces[0] || projects[0] || '';
  if (!projectFile) return null;
  return {
    stack: 'xcode',
    label: 'Apple Xcode project',
    confidence: 'high',
    markers: [projectFile],
    runtimes: ['xcode'],
    projectFile,
  };
}

const DETECTORS = [
  detectNode,
  detectDocker,
  detectGo,
  detectRust,
  detectJava,
  detectPhp,
  detectRuby,
  detectDotnet,
  detectPython,
  detectXcode,
  detectMake,
];

/**
 * @param {Array<{path: string, size: number}>} entries
 * @param {Record<string, string>} manifests file name -> content
 */
function detectStack(entries, manifests = {}) {
  const found = [];
  for (const detector of DETECTORS) {
    try {
      const result = detector(entries, manifests);
      if (result) found.push(result);
    } catch {
      /* a broken detector must never break the analysis */
    }
  }

  // When a repository carries several manifests, the stack that actually runs
  // the application wins: package.json is asset tooling for a Laravel, Rails,
  // Go or .NET project, not the thing that has to be installed.
  const order = ['php', 'ruby', 'dotnet', 'java', 'go', 'rust', 'node', 'python', 'docker', 'xcode', 'make'];
  found.sort((a, b) => order.indexOf(a.stack) - order.indexOf(b.stack));

  const primary = found[0] || null;
  const secondary = found.slice(1).map((item) => ({ stack: item.stack, label: item.label }));

  return {
    primary,
    secondary,
    all: found,
    manifestsPresent: MANIFESTS.filter((name) => has(entries, name)),
    fileCount: entries.length,
  };
}

module.exports = { detectStack, MANIFESTS };
