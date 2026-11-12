'use strict';

/**
 * Project categories.
 *
 * A repository is not a stack, it is a kind of thing, and the kind decides what
 * GUITinstal may offer to do with it. A web application is opened in a
 * browser, a command line tool is run with arguments, a library is not run at
 * all, and a desktop application opens a window. Offering "Run" for something
 * that has no entry point is how an installer loses the trust of the person
 * using it.
 *
 * The classification is a pure function of what the scanner found: the file
 * tree, the manifest contents and the stack detection. When the evidence does
 * not point anywhere, the answer is "unknown" plus a question, never a guess.
 */

const TYPES = {
  'desktop-application': {
    label: 'Desktop application',
    launchModel: 'run-app',
    description: 'An application with its own window. GUITinstal starts the process and keeps it in the library.',
    actions: ['install', 'run', 'stop', 'logs', 'open-folder', 'update', 'uninstall'],
  },
  'web-application': {
    label: 'Web application',
    launchModel: 'open-in-browser',
    description: 'A site or dashboard. GUITinstal starts the server and opens it in the browser.',
    actions: ['install', 'run', 'open-app', 'stop', 'logs', 'open-folder', 'update', 'uninstall'],
  },
  'backend-service': {
    label: 'Backend service',
    launchModel: 'start-stop',
    description: 'A service with no interface of its own. GUITinstal starts and stops it.',
    actions: ['install', 'run', 'stop', 'logs', 'open-folder', 'update', 'uninstall'],
  },
  'cli-tool': {
    label: 'Command line tool',
    launchModel: 'run-command',
    description: 'A program you run with arguments. GUITinstal installs it and shows the command.',
    actions: ['install', 'run', 'logs', 'open-folder', 'update', 'uninstall'],
  },
  library: {
    label: 'Library',
    launchModel: 'open-project',
    description: 'Code meant to be used by other projects. GUITinstal installs the dependencies and opens the folder.',
    actions: ['install', 'docs', 'open-folder', 'update', 'uninstall'],
  },
  framework: {
    label: 'Framework or extension',
    launchModel: 'configure-project',
    description: 'Something that extends a host application. GUITinstal prepares it and explains where it goes.',
    actions: ['install', 'configure', 'open-folder', 'update', 'uninstall'],
  },
  template: {
    label: 'Project template',
    launchModel: 'configure-project',
    description: 'A starting point to copy. GUITinstal prepares it so you can create a new project from it.',
    actions: ['install', 'configure', 'open-folder', 'update', 'uninstall'],
  },
  'ai-application': {
    label: 'AI application',
    launchModel: 'inherit',
    description: 'An application built around an AI model. It runs like the kind of application it really is.',
    actions: ['install', 'run', 'open-app', 'stop', 'logs', 'open-folder', 'update', 'uninstall'],
  },
  'apple-application': {
    label: 'Apple app',
    launchModel: 'open-in-xcode',
    description: 'An Apple-platform project. GUITinstal opens it in Xcode on macOS; building and signing stay in Xcode.',
    actions: ['install', 'open-in-xcode', 'open-folder'],
  },
  'ai-skill': {
    label: 'AI skill or plugin',
    launchModel: 'install-in-host',
    description: 'A skill, prompt pack or plugin for an AI host. GUITinstal installs it into a compatible host.',
    actions: ['install-host', 'open-folder', 'update', 'uninstall'],
  },
  'multi-service-application': {
    label: 'Multi-service application',
    launchModel: 'start-stop',
    description: 'Several services that belong together. GUITinstal brings the whole set up.',
    actions: ['install', 'run', 'stop', 'logs', 'open-folder', 'update', 'uninstall'],
  },
  unknown: {
    label: 'Unrecognized project',
    launchModel: 'configure-project',
    description: 'GUITinstal could not tell what this repository is, so it asks instead of guessing.',
    actions: ['open-folder', 'configure'],
  },
};

const QUESTIONS = {
  unknown:
    'This repository has no entry point GUITinstal recognizes. Should GUITinstal follow the README instructions, or is this a library you only want to keep on disk?',
  'ai-skill':
    'This looks like an AI skill or plugin. Which host should GUITinstal install it into?',
};

/** File names that mean "this is a skill or a plugin for an AI host". */
const SKILL_FILES = [
  'skill.md',
  'skills/',
  'plugin.json',
  '.mcp.json',
  'agent.json',
  'agents/',
  'commands/',
  'prompts/',
  'hooks/',
  'mcp.json',
  '.claude-plugin/',
];

/** Dependencies that mark a desktop application. */
const DESKTOP_DEPS = ['electron', 'electron-builder', '@tauri-apps/api', 'tauri', 'neutralino', 'nw', 'pywebview'];

/** Python and Rust desktop toolkits. */
const DESKTOP_FRAMEWORKS = ['tkinter', 'pyqt', 'pyside', 'kivy', 'wxpython', 'customtkinter'];

/** Dependencies that mark an application built around an AI model. */
const AI_DEPS = [
  'openai',
  'anthropic',
  '@anthropic-ai/sdk',
  'langchain',
  'langchain-openai',
  'langgraph',
  'llama-index',
  'transformers',
  'ollama',
  'crewai',
  'autogen',
  'semantic-kernel',
  'vercel-ai',
  'ai',
  'litellm',
  'cohere',
  'mistralai',
  'huggingface-hub',
];

/** Frameworks that put something in a browser. */
const WEB_FRAMEWORKS = [
  'next',
  'react',
  'vue',
  'svelte',
  'nuxt',
  'remix',
  'astro',
  'angular',
  'gatsby',
  'vite',
  'django',
  'flask',
  'fastapi',
  'streamlit',
  'gradio',
  'laravel',
  'symfony',
  'rails',
  'spring-boot',
  'gin-gonic',
  'echo',
  'axum',
  'actix-web',
  'rocket',
  'express',
  'fastify',
  'koa',
  'hapi',
  'nestjs',
];

const API_FRAMEWORKS = ['fastapi', 'flask', 'express', 'fastify', 'koa', 'hapi', 'nestjs', 'gin-gonic', 'axum', 'actix-web', 'rocket'];

function lower(value) {
  return String(value || '').toLowerCase();
}

function parseJson(content) {
  try {
    const value = JSON.parse(content);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Every path in the tree, lowercased, so a marker can be found anywhere. */
function paths(entries) {
  return (entries || []).map((entry) => lower(entry.path));
}

function hasPath(list, needle) {
  return list.some((item) => item === needle || item.startsWith(needle) || item.includes(`/${needle}`));
}

function hasAnyPath(list, needles) {
  return needles.some((needle) => hasPath(list, needle));
}

/** The dependency names declared by whichever manifest the project uses. */
function dependencyNames(manifests) {
  const names = new Set();
  const pkg = parseJson(manifests['package.json']);
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg?.[group] || {})) names.add(lower(name));
  }
  const composer = parseJson(manifests['composer.json']);
  for (const name of Object.keys(composer?.require || {})) names.add(lower(name));
  const cargo = manifests['Cargo.toml'] || '';
  for (const match of cargo.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) names.add(lower(match[1]));
  const pyproject = `${manifests['pyproject.toml'] || ''}\n${manifests['requirements.txt'] || ''}`.toLowerCase();
  for (const name of AI_DEPS) if (pyproject.includes(name)) names.add(name);
  for (const name of WEB_FRAMEWORKS) if (pyproject.includes(name)) names.add(name);
  for (const name of DESKTOP_FRAMEWORKS) if (pyproject.includes(name)) names.add(name);
  return names;
}

function scriptsOf(manifests) {
  const pkg = parseJson(manifests['package.json']);
  return Object.keys(pkg?.scripts || {});
}

/** A CLI is declared by a bin entry, an entry point or a console script. */
function cliMarkers(manifests, list) {
  const markers = [];
  const pkg = parseJson(manifests['package.json']);
  if (pkg?.bin) markers.push('package.json bin');
  const pyproject = manifests['pyproject.toml'] || '';
  if (/\[project\.scripts\]|\[tool\.poetry\.scripts\]/.test(pyproject)) markers.push('python console script');
  if (/entry_points\s*=/.test(manifests['setup.py'] || '')) markers.push('setup.py entry_points');
  if (hasAnyPath(list, ['cmd/', 'cli/', 'bin/', 'exe/'])) markers.push('command line folder');
  const cargo = manifests['Cargo.toml'] || '';
  if (/\[\[bin\]\]/.test(cargo) || /clap|structopt|cobra/.test(cargo)) markers.push('Cargo command');
  return markers;
}

/** Several services that belong together. */
function multiServiceMarkers(manifests, list) {
  const markers = [];
  const compose = manifests['docker-compose.yml'] || manifests['compose.yaml'] || manifests['compose.yml'] || '';
  const services = (compose.match(/^\s{2}[a-zA-Z0-9_-]+:/gm) || []).length;
  if (services > 1) markers.push(`${services} services in the compose file`);
  if (hasAnyPath(list, ['services/', 'apps/', 'packages/'])) {
    const manifestsFound = (list || []).filter((item) => /(^|\/)(package\.json|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml)$/.test(item));
    if (manifestsFound.length > 1) markers.push(`${manifestsFound.length} independent manifests`);
  }
  return markers;
}

/** A plugin or extension meant for a host application. */
function frameworkMarkers(manifests, list) {
  const markers = [];
  const pkg = parseJson(manifests['package.json']);
  if (pkg?.contributes) markers.push('package.json contributes');
  if (hasAnyPath(list, ['plugin.json', 'extension.json', 'manifest.json'])) markers.push('extension manifest');
  if (/\[tool\.poetry\.[^\]]*\]|plugins\s*=|entry_points/.test(manifests['setup.py'] || '')) markers.push('python plugin entry point');
  return markers;
}

/** A starting point to copy rather than a program to run. */
function templateMarkers(repo, manifests, list) {
  const markers = [];
  const name = `${repo?.name || ''} ${repo?.description || ''}`.toLowerCase();
  if (/\b(template|scaffold|starter|boilerplate|cookiecutter|kit|example project)\b/.test(name)) {
    markers.push('the repository describes itself as a template');
  }
  if (hasAnyPath(list, ['cookiecutter.json', 'template.json', 'template.yaml', 'template.yml', 'scaffold'])) {
    markers.push('template configuration file');
  }
  if (hasAnyPath(list, ['templates/']) && hasAnyPath(list, ['project.json', 'template.json'])) {
    markers.push('template folder with a project file');
  }
  return markers;
}

/** Something built around an AI model. */
function aiMarkers(manifests, names) {
  const markers = [];
  for (const name of AI_DEPS) {
    if (!names.has(name)) continue;
    // "ai" is a common substring, so it only counts as an exact dependency.
    if (name === 'ai' && !names.has('ai')) continue;
    markers.push(name);
  }
  return markers;
}

/** A desktop application: its own window. */
function desktopMarkers(manifests, names, list, detection) {
  const markers = [];
  for (const name of DESKTOP_DEPS) if (names.has(name)) markers.push(name);
  for (const name of DESKTOP_FRAMEWORKS) if (names.has(name)) markers.push(name);
  if (hasAnyPath(list, ['src-tauri/'])) markers.push('Tauri project');
  if (hasAnyPath(list, ['.csproj'])) {
    const project = (list || []).find((item) => item.endsWith('.csproj')) || '';
    if (project) {
      const content = manifests[Object.keys(manifests).find((key) => lower(key).endsWith('.csproj'))] || '';
      if (/UseWPF|UseWindowsForms|net\d+-windows/.test(content)) markers.push('Windows desktop project');
    }
  }
  if (detection?.primary?.stack === 'rust' && names.has('tauri')) markers.push('Tauri project');
  return markers;
}

/** The launch profile of a category. */
function launchProfile(typeId) {
  const type = TYPES[typeId] || TYPES.unknown;
  return {
    model: type.launchModel,
    label: type.label,
    description: type.description,
    actions: [...type.actions],
  };
}

/**
 * Classifies a repository.
 *
 * @param {object} input
 * @param {Array<{path: string}>} input.entries file tree
 * @param {Record<string, string>} input.manifests file name -> content
 * @param {object} input.detection output of detectStack
 * @param {object} input.repo repository metadata
 */
function classify(input = {}) {
  const entries = input.entries || [];
  const manifests = input.manifests || {};
  const detection = input.detection || {};
  const repo = input.repo || {};
  const list = paths(entries);
  const names = dependencyNames(manifests);
  const scripts = scriptsOf(manifests);

  const skill = hasAnyPath(list, SKILL_FILES) ? ['skill or plugin manifest'] : [];
  const multi = multiServiceMarkers(manifests, list);
  const desktop = desktopMarkers(manifests, names, list, detection);
  const ai = aiMarkers(manifests, names);
  const cli = cliMarkers(manifests, list);
  const framework = frameworkMarkers(manifests, list);
  const template = templateMarkers(repo, manifests, list);
  const web = WEB_FRAMEWORKS.filter((name) => names.has(name));
  const api = API_FRAMEWORKS.filter((name) => names.has(name));

  const primary = detection.primary || null;
  const hasManifest = Boolean(primary);
  const stack = primary?.stack || '';
  const webByStack = ['php', 'ruby'].includes(stack) || (stack === 'java' && primary?.framework === 'spring');
  const webByScripts = scripts.some((name) => ['dev', 'serve', 'start'].includes(name));
  const webMarkers = [...web, ...(webByStack ? [stack] : []), ...(webByScripts ? ['package script'] : [])];

  const base = (type, markers, confidence, extra = {}) => ({
    type,
    label: TYPES[type].label,
    confidence,
    markers: [...new Set(markers)].slice(0, 6),
    launch: launchProfile(type),
    question: QUESTIONS[type] || '',
    ...extra,
  });

  // A skill or plugin is not run by GUITinstal, it is installed into a host.
  if (skill.length) {
    return base('ai-skill', skill, 'high', { inner: '' });
  }

  if (primary?.stack === 'xcode') {
    return base('apple-application', ['Xcode project'], 'high');
  }

  // Several services that belong together are one installation.
  if (multi.length) {
    return base('multi-service-application', multi, 'high');
  }

  if (desktop.length) {
    return base('desktop-application', desktop, 'high');
  }

  // An AI application is still a web app, a service or a command. The kind is
  // recorded, and the launch model follows the shape it really has.
  if (ai.length) {
    let inner = 'library';
    if (cli.length) inner = 'cli-tool';
    else if (webMarkers.length) inner = 'web-application';
    else if (api.length) inner = 'backend-service';
    const launch = launchProfile(inner);
    return {
      type: 'ai-application',
      label: TYPES['ai-application'].label,
      confidence: inner === 'library' ? 'medium' : 'high',
      markers: [...ai, ...(inner === 'library' ? [] : [inner.replace('-', ' ')])].slice(0, 6),
      launch: { ...launch, model: launch.model, inheritedFrom: inner },
      inner,
      question: '',
    };
  }

  if (cli.length && !webMarkers.length) {
    return base('cli-tool', cli, 'high');
  }

  if (webMarkers.length) {
    // A service with only an API and no interface is a backend, not a site.
    const onlyApi = api.length && !web.some((name) => !API_FRAMEWORKS.includes(name));
    if (onlyApi && !webByScripts && !webByStack) {
      return base('backend-service', api, 'medium');
    }
    return base('web-application', webMarkers, 'high');
  }

  if (stack === 'docker' && primary?.compose) {
    return base('backend-service', ['compose file'], 'medium');
  }

  if (framework.length) {
    return base('framework', framework, 'medium');
  }

  if (template.length) {
    return base('template', template, 'medium');
  }

  if (hasManifest) {
    // A manifest with no entry point is a library. It is installed, but it is
    // never "run".
    const markers = [primary.markers?.[0] || primary.label];
    return base('library', markers, 'medium');
  }

  return base('unknown', [], 'low');
}

module.exports = { QUESTIONS, TYPES, classify, launchProfile };
